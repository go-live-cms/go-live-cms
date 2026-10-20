// The WebSocket upgrade flow: ticket auth + role check + doc-name validation
// (#216, #220, #223, #233).
//
// Extracted from server.js (which boots the server on import) so the ordering
// guarantees are unit tested in upgrade.test.js:
//   1. the credential is taken and stripped from req.url before anything reads it,
//   2. a bad doc name gets 400 before any auth work,
//   3. client context (origin, UA, peer IP) is logged only on rejections.
// Dependencies are injected. Must NOT import yjs — see the single-yjs-instance gotcha
// in websocket/CLAUDE.md.
import { canEditContent, isCollabDocName, stripCollabPrefix, takeCredential, ticketIdentity } from "./access.js";
import { docNameForLog, upgradeContextForLog } from "./logsafe.js";

// Derive the Yjs document name (e.g. "post-2892") from the request URL, the same way
// y-websocket's setupWSConnection does, so we can correlate connection counts.
export const docNameFromReq = (req) => (req.url || "/").slice(1).split("?")[0].split("#")[0];

/**
 * Returns an `upgrade` listener.
 * - verifyTicket(ticket, docName) → the ticket's claims; throws if it is invalid,
 *   expired, not a ticket, or for another doc (→ 401).
 * - consumeTicket(claims) → false if the ticket was already used (→ 401). Burning it
 *   happens before the role lookup, so a ticket can't be retried after a failure.
 * - fetchRole(identity) → the user's CURRENT role from the API's internal listener, or
 *   null if the user is gone or the ticket predates a password change (→ 403); throws if
 *   the API can't answer (→ 503). identity is ticketIdentity(claims): { userId, issuedAt }.
 * - accept(req, socket, head) completes the WebSocket handshake.
 */
export function createUpgradeHandler({ verifyTicket, consumeTicket, fetchRole, accept }) {
  return async (req, socket, head) => {
    // Node's http server removes its own socket 'error' listener before emitting
    // 'upgrade'. Without this one, a client that disconnects while we await the role
    // lookup (ECONNRESET), or a write to an already-closed peer (EPIPE), is an
    // uncaught 'error' that crashes the process and every live collab session.
    socket.on("error", (err) => {
      console.warn("⚠️  Upgrade socket error:", err.code || err.message);
    });
    // The single-use ticket rides in ?ticket= (#233). takeCredential strips it from
    // req.url before anything else reads the request, so nothing below (or y-websocket)
    // can log it (#220). Still never log req.headers; use the logsafe.js views.
    const credential = takeCredential(req);
    stripCollabPrefix(req);
    const rawDocName = docNameFromReq(req);
    const docName = docNameForLog(rawDocName);
    console.log(`📡 WebSocket upgrade request for doc: ${docName}`);

    // Rejections log the client context (origin, UA, peer IP) to make them traceable;
    // accepted upgrades don't, so we don't retain that for every editor connect.
    const reject = (status, body, reason, { warn = false } = {}) => {
      const line = `🚫 ${reason} | doc ${docName} | ${upgradeContextForLog(req)}`;
      if (warn) console.warn(line);
      else console.error(line);
      socket.write(`HTTP/1.1 ${status}\r\n\r\n${body}\r\n`);
      socket.destroy();
    };

    if (!isCollabDocName(rawDocName)) {
      reject("400 Bad Request", "Unknown document", "Invalid document name", { warn: true });
      return;
    }
    if (!credential) {
      reject("401 Unauthorized", "No ticket provided", "No ticket provided");
      return;
    }

    let claims;
    try {
      claims = await verifyTicket(credential, rawDocName);
    } catch (error) {
      reject(
        "401 Unauthorized",
        "Invalid or expired ticket",
        `Ticket rejected: ${error.message}`,
      );
      return;
    }
    const who = claims.username || claims.sub;

    // Single use: a ticket that leaked (e.g. into a proxy access log) can't open a second
    // socket. Burned before the role lookup, so a failed lookup can't be retried with it;
    // the editor fetches a fresh ticket on every reconnect.
    if (!consumeTicket(claims)) {
      reject("401 Unauthorized", "Invalid or expired ticket", `Ticket already used by user ${who}`, { warn: true });
      return;
    }

    // The role always comes from the DB (tickets carry no role claim), looked up on the
    // API's internal listener with the shared secret. The ticket never leaves this process.
    const identity = ticketIdentity(claims);
    if (!identity) {
      reject("403 Forbidden", "Insufficient role for collaborative editing", `Ticket for ${who} has no valid user_id/iat`);
      return;
    }
    let role;
    try {
      role = await fetchRole(identity);
    } catch (err) {
      reject("503 Service Unavailable", "Could not verify user role", `Role lookup failed for user ${who}: ${err.message}`);
      return;
    }
    if (!canEditContent(role)) {
      reject(
        "403 Forbidden",
        "Insufficient role for collaborative editing",
        `Forbidden: user ${who} (role: ${role || "none"}) cannot edit`,
        { warn: true },
      );
      return;
    }
    console.log(`👤 Ticket accepted for user ${who} (role: ${role}), doc ${docName}`);

    req.auth = {
      sub: claims.sub,
      userId: identity.userId,
      username: claims.username,
      role,
    };
    try {
      accept(req, socket, head);
    } catch (error) {
      reject("500 Internal Server Error", "Upgrade failed", `WebSocket handshake failed: ${error.message}`);
    }
  };
}
