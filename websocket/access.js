// Ticket auth + role-based access control for collab connections (#216, #220, #223, #233).
//
// The editor never puts its access token in the socket URL: proxy and load balancer
// access logs record that URL. Before each connect it asks the API for a ticket, a
// v4.public PASETO with audience golive.admin-ws, token_type ws_ticket, a `doc` claim, a
// jti and a 30s lifetime (token/ws_ticket.go). The upgrade (upgrade.js) then:
//   1. verifyTicket: checks signature, issuer, audience, type, expiry and doc locally;
//   2. a TicketReplayGuard burns the jti, so a ticket that leaked (e.g. into a proxy
//      access log) can never open a second socket;
//   3. fetchCurrentRole: reads the user's CURRENT role from the API's internal listener
//      (GET /internal/users/:id/role, a separate port that isn't published),
//      authenticated with the shared ROLE_LOOKUP_SECRET, NOT with the ticket (#223).
//      The ticket never leaves this process.
// A PASETO `role` claim (tickets carry none) is never used to authorize: it goes stale on
// demotion. The API reads the role from the DB, the same way api/auth_roles.go's
// requireRole does for REST requests.
//
// Pure + dependency-injected (fetchImpl, keys, clock) so it's unit tested in
// access.test.js. Must NOT import yjs — see the single-yjs-instance gotcha in
// websocket/CLAUDE.md.
import { V4 } from "paseto";

// Must match token.WSTicketAudience / token.WSTicketType in token/ws_ticket.go.
export const TICKET_AUDIENCE = "golive.admin-ws";
export const TICKET_TYPE = "ws_ticket";

// Clock skew tolerated when checking a ticket's expiry. The replay guard must remember a
// jti for at least this long past `exp`, or a burned ticket would verify again.
export const TICKET_CLOCK_TOLERANCE_MS = 5_000;

// Roles allowed to edit post content. Mirrors requireContentEditor in
// api/auth_roles.go, which is the source of truth — keep the two in sync.
export const CONTENT_EDITOR_ROLES = ["admin", "editor"];

// Case-insensitive, matching the API's strings.EqualFold role comparison.
export function canEditContent(role) {
  if (typeof role !== "string" || !role) return false;
  const normalized = role.toLowerCase();
  return CONTENT_EDITOR_ROLES.includes(normalized);
}

// The only doc names the editor opens (`post-${postId}` in CollaborationProvider.ts).
// Anything else is rejected before auth, so a client can't make the server create and
// persist Yjs docs under arbitrary names, or put crafted text into log lines.
const COLLAB_DOC_NAME = /^post-[1-9]\d{0,18}$/;

export function isCollabDocName(name) {
  return typeof name === "string" && COLLAB_DOC_NAME.test(name);
}

// Reads the ticket from an upgrade request (?ticket=) and strips the query string and
// fragment from req.url, so nothing downstream (y-websocket's setupWSConnection, the
// connection handler, any log) can see it (#220). Returns null when there is none.
// The pre-#233 ?token= param is NOT read: access tokens never authenticate a socket.
export function takeCredential(req) {
  const raw = req.url || "/";
  const params = new URLSearchParams(raw.split("#")[0].split("?").slice(1).join("?"));
  req.url = raw.split("?")[0].split("#")[0];
  return params.get("ticket") || null;
}

// Outside development the editor connects to `${location.host}/collab/post-<id>`
// (CollaborationProvider.ts) through a reverse proxy, which may or may not strip the
// prefix. Drop it here so the doc name (y-websocket's, LevelDB's, the logs', and the
// API's squash calls, which use bare post-<id>) is the same either way. Run after
// takeCredential, which has already removed the query string.
export const COLLAB_PATH_PREFIX = "/collab";

export function stripCollabPrefix(req) {
  const url = req.url || "/";
  if (url.startsWith(`${COLLAB_PATH_PREFIX}/`)) req.url = url.slice(COLLAB_PATH_PREFIX.length);
}

// Checks a ticket locally. Resolves to its claims; rejects if the signature, issuer,
// audience, expiry or type is wrong, it has no jti/exp (needed to burn it), or it was
// minted for another document. An access token (audience golive.admin, token_type
// access) is rejected.
export async function verifyTicket(ticket, publicKey, { issuer, docName }) {
  const payload = await V4.verify(ticket, publicKey, {
    issuer,
    audience: TICKET_AUDIENCE,
    clockTolerance: `${TICKET_CLOCK_TOLERANCE_MS / 1000}s`,
  });
  if (payload.token_type !== TICKET_TYPE) {
    throw new Error("not a collab ticket");
  }
  if (typeof payload.doc !== "string" || payload.doc !== docName) {
    throw new Error("ticket was issued for a different document");
  }
  if (typeof payload.jti !== "string" || !payload.jti || !Number.isFinite(Date.parse(payload.exp))) {
    throw new Error("ticket has no jti or exp");
  }
  return payload;
}

// Remembers burned ticket ids until they can no longer verify, which makes tickets
// single use. In-memory, so it assumes ONE collab server process. That already holds:
// y-websocket keeps live docs in memory, so running two would split documents anyway.
// Only VERIFIED tickets are consumed, so a client can't grow the map with junk, and
// entries are dropped once their ticket is past exp + clock tolerance.
export class TicketReplayGuard {
  #used = new Map(); // jti → ms after which the ticket can't verify any more

  // Marks the ticket as used. Returns false if it already was.
  consume(payload, now = Date.now()) {
    for (const [jti, until] of this.#used) {
      if (now > until) this.#used.delete(jti);
    }
    if (this.#used.has(payload.jti)) return false;
    this.#used.set(payload.jti, Date.parse(payload.exp) + TICKET_CLOCK_TOLERANCE_MS);
    return true;
  }

  get size() {
    return this.#used.size;
  }
}

// Extracts what the role lookup needs from a VERIFIED ticket payload: the user's DB id
// (`user_id`, a decimal string set by token/ws_ticket.go) and `iat` as Unix seconds
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
// requestId (the upgrade's) is sent as X-Request-ID so the API logs the lookup under it.
export async function fetchCurrentRole(
  apiUrl,
  { userId, issuedAt },
  secret,
  { fetchImpl = fetch, timeoutMs = 3000, requestId } = {},
) {
  const url =
    `${apiUrl.replace(/\/+$/, "")}/internal/users/${encodeURIComponent(userId)}/role` +
    `?issued_at=${encodeURIComponent(issuedAt)}`;
  const headers = { Authorization: `Bearer ${secret}`, Accept: "application/json" };
  if (requestId) headers["X-Request-ID"] = requestId;
  const res = await fetchImpl(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (res.status === 403 || res.status === 404) return null;
  if (res.status === 401) throw new Error("role lookup failed: API rejected ROLE_LOOKUP_SECRET (401)");
  if (!res.ok) throw new Error(`role lookup failed: API responded ${res.status}`);

  const body = await res.json();
  const role = body?.role;
  return typeof role === "string" ? role : null;
}
