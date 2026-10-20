// Ticket verification + role-based access control for collab connections (#216, #223).
//
// The PASETO `role` claim is informational only: it goes stale on demotion and is empty
// on tokens issued by refresh (see token/payload.go). So the caller's CURRENT role is
// fetched from the API on every upgrade, read from the DB the same way
// api/auth_roles.go's requireRole does for REST requests.
//
// The lookup goes to the API's internal listener (GET /internal/users/:id/role, a separate
// port that isn't published), authenticated with the shared ROLE_LOOKUP_SECRET, NOT with
// the client's ticket (#223).
// It used to call /users/me with the ticket, which only worked while the API accepted the
// ticket as an API access token; a WS-only ticket (audience golive.admin-ws) would get 401
// there and every user would be locked out. The ticket now never leaves this process.
//
// Pure + dependency-injected (fetchImpl, verify) so it's unit tested in access.test.js.
// Must NOT import yjs — see the single-yjs-instance gotcha in websocket/CLAUDE.md.

import { V4 } from "paseto";

// Roles allowed to edit post content. Mirrors requireContentEditor in
// api/auth_roles.go, which is the source of truth — keep the two in sync.
export const CONTENT_EDITOR_ROLES = ["admin", "editor"];

// Case-insensitive, matching the API's strings.EqualFold role comparison.
export function canEditContent(role) {
  if (typeof role !== "string" || !role) return false;
  const normalized = role.toLowerCase();
  return CONTENT_EDITOR_ROLES.includes(normalized);
}

// token_type values accepted as a collab ticket. The API's authMiddleware used to enforce
// "access" when the ticket was forwarded to /users/me; we must enforce it ourselves now so
// any future v4.public token signed with the same key (e.g. a link token) can't open a
// socket. Add a dedicated WS ticket type here when the API starts issuing one.
export const ACCEPTED_TOKEN_TYPES = ["access"];

// Verifies a PASETO v4.public ticket against each allowed audience in turn, and requires
// an accepted token_type. Returns { payload, footer, audience } or null if it isn't valid.
export async function verifyTicket(credential, { publicKey, issuer, audiences, verify = V4.verify }) {
  for (const aud of audiences) {
    try {
      const result = await verify(credential, publicKey, {
        issuer,
        audience: aud.trim(),
        clockTolerance: "60s",
        complete: true,
      });
      if (!ACCEPTED_TOKEN_TYPES.includes(result.payload?.token_type)) return null;
      return { payload: result.payload, footer: result.footer, audience: aud.trim() };
    } catch {
      continue;
    }
  }
  return null;
}

// Extracts what the role lookup needs from a VERIFIED ticket payload: the user's DB id
// (`user_id`, a decimal string set by token/paseto_v4_maker.go) and `iat` as Unix seconds
// (so the API can refuse tickets issued before the user's latest password change).
// Returns null when either is missing or malformed → caller denies (403).
export function ticketIdentity(payload) {
  const rawId = payload?.user_id;
  const userId = typeof rawId === "number" ? String(rawId) : rawId;
  if (typeof userId !== "string" || !/^[1-9]\d*$/.test(userId)) return null;

  const issuedAtMs = typeof payload?.iat === "string" ? Date.parse(payload.iat) : NaN;
  if (!Number.isFinite(issuedAtMs)) return null;

  return { userId, issuedAt: Math.floor(issuedAtMs / 1000) };
}

// Fetches the user's current role from the API's internal endpoint.
//
// Returns:
//   - the role string on 200
//   - null on 403/404 (ticket predates a password change, or user deleted) → caller denies (403)
// Throws on any other status (including 401 = ROLE_LOOKUP_SECRET mismatch, a config
// error rather than a user error), a network error or a timeout → caller answers 503.
// Either way the connection is never allowed without a verified editor role.
export async function fetchCurrentRole(apiUrl, { userId, issuedAt }, secret, { fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  const url =
    `${apiUrl.replace(/\/+$/, "")}/internal/users/${encodeURIComponent(userId)}/role` +
    `?issued_at=${encodeURIComponent(issuedAt)}`;
  const res = await fetchImpl(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (res.status === 403 || res.status === 404) return null;
  if (res.status === 401) throw new Error("role lookup failed: API rejected ROLE_LOOKUP_SECRET (401)");
  if (!res.ok) throw new Error(`role lookup failed: API responded ${res.status}`);

  const body = await res.json();
  const role = body?.role;
  return typeof role === "string" ? role : null;
}

// Full upgrade decision: verify the ticket, then look up the current role.
//
// Returns { ok: true, payload, footer, audience, role } to admit, or
// { ok: false, status, reason, payload? } to refuse with 401 (bad ticket),
// 403 (not an editor / unknown user / revoked) or 503 (lookup failed). Fails closed.
export async function authorizeUpgrade(credential, { publicKey, issuer, audiences, apiUrl, secret, fetchImpl, timeoutMs, verify }) {
  const verified = await verifyTicket(credential, { publicKey, issuer, audiences, verify });
  if (!verified) {
    return {
      ok: false,
      status: 401,
      reason: `ticket invalid (bad signature/issuer/expiry, audience not in ${audiences.join(", ")}, or token_type not ${ACCEPTED_TOKEN_TYPES.join("/")})`,
    };
  }
  const { payload } = verified;

  const identity = ticketIdentity(payload);
  if (!identity) {
    return { ok: false, status: 403, reason: "ticket has no valid user_id/iat", payload };
  }

  let role;
  try {
    role = await fetchCurrentRole(apiUrl, identity, secret, { fetchImpl, timeoutMs });
  } catch (err) {
    return { ok: false, status: 503, reason: err.message, payload };
  }
  if (!canEditContent(role)) {
    return { ok: false, status: 403, reason: `role ${role || "none"} cannot edit content`, payload };
  }
  return { ok: true, ...verified, role };
}
