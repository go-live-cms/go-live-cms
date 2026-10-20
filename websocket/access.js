// Ticket auth + role-based access control for collab connections (#216, #220, #233).
//
// The editor never puts its access token in the socket URL: proxy and load balancer
// access logs record that URL. Before each connect it asks the API for a ticket, a
// v4.public PASETO with audience golive.admin-ws, token_type ws_ticket, a `doc` claim
// and a 30s lifetime (token/ws_ticket.go). The upgrade (upgrade.js) then:
//   1. verifyTicket: checks signature, issuer, audience, type, expiry and doc locally,
//      so garbage never reaches the API;
//   2. redeemTicket: POSTs it to the API, which burns its jti (single use) and returns
//      the user's CURRENT role from the DB, the same way api/auth_roles.go's requireRole
//      does for REST requests.
// A PASETO `role` claim (tickets carry none) is never used to authorize.
//
// Pure + dependency-injected (fetchImpl, keys) so it's unit tested in access.test.js.
// Must NOT import yjs — see the single-yjs-instance gotcha in websocket/CLAUDE.md.
import { V4 } from "paseto";

// Must match token.WSTicketAudience / token.WSTicketType in token/ws_ticket.go.
export const TICKET_AUDIENCE = "golive.admin-ws";
export const TICKET_TYPE = "ws_ticket";

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
// audience, expiry or type is wrong, or the ticket was minted for another document.
// An access token (audience golive.admin, token_type access) is rejected.
export async function verifyTicket(ticket, publicKey, { issuer, docName }) {
  const payload = await V4.verify(ticket, publicKey, {
    issuer,
    audience: TICKET_AUDIENCE,
    clockTolerance: "5s",
  });
  if (payload.token_type !== TICKET_TYPE) {
    throw new Error("not a collab ticket");
  }
  if (typeof payload.doc !== "string" || payload.doc !== docName) {
    throw new Error("ticket was issued for a different document");
  }
  return payload;
}

// Redeems a ticket at the API (POST /collab/tickets/redeem). This burns it.
//
// Returns:
//   - { userId, username, role, doc } on 200 (role is null if the body has none)
//   - null on 401/403/404 (ticket already used, expired, issued before a password
//     change, or the user is gone) → caller denies
// Throws on any other status, a network error or a timeout → caller answers 503.
// Either way the connection is never allowed without a verified editor role.
export async function redeemTicket(apiUrl, ticket, { fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  const url = `${apiUrl.replace(/\/+$/, "")}/collab/tickets/redeem`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${ticket}`, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (res.status === 401 || res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw new Error(`ticket redemption failed: API responded ${res.status}`);

  const body = await res.json();
  const user = body?.user ?? {};
  return {
    userId: user.id,
    username: user.username,
    role: typeof user.role === "string" ? user.role : null,
    doc: body?.doc,
  };
}
