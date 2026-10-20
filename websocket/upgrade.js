// The WebSocket upgrade flow: ticket auth + role check + doc-name validation (#216, #220, #233).
//
// Extracted from server.js (which boots the server on import) so the ordering
// guarantees are unit tested in upgrade.test.js:
//   1. the credential is taken and stripped from req.url before anything reads it,
//   2. a bad doc name gets 400 before any auth work,
//   3. client context (origin, UA, peer IP) is logged only on rejections.
// Dependencies are injected. Must NOT import yjs — see the single-yjs-instance gotcha
// in websocket/CLAUDE.md.
import { canEditContent, isCollabDocName, stripCollabPrefix, takeCredential } from "./access.js";
import { docNameForLog, upgradeContextForLog } from "./logsafe.js";

// Derive the Yjs document name (e.g. "post-2892") from the request URL, the same way
// y-websocket's setupWSConnection does, so we can correlate connection counts.
export const docNameFromReq = (req) => (req.url || "/").slice(1).split("?")[0].split("#")[0];

/**
 * Returns an `upgrade` listener.
 * - verifyTicket(ticket, docName) → the ticket's claims; throws if it is invalid,
 *   expired, not a ticket, or for another doc (→ 401).
 * - redeemTicket(ticket) → { userId, username, role, doc }, or null if the API refuses
 *   it (→ 401); throws if the API can't answer (→ 503). Redeeming burns the ticket.
 * - accept(req, socket, head) completes the WebSocket handshake.
 */
export function createUpgradeHandler({ verifyTicket, redeemTicket, accept }) {
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

    // Redeeming burns the ticket and returns the CURRENT role from the DB. Tickets carry
    // no role claim, and access is never decided from token contents.
    let redeemed;
    try {
      redeemed = await redeemTicket(credential);
    } catch (err) {
      reject(
        "503 Service Unavailable",
        "Could not verify ticket",
        `Ticket redemption failed for user ${claims.username || claims.sub}: ${err.message}`,
      );
      return;
    }
    if (!redeemed || redeemed.doc !== rawDocName) {
      reject(
        "401 Unauthorized",
        "Invalid or expired ticket",
        `API refused ticket for user ${claims.username || claims.sub} (used, expired or revoked)`,
        { warn: true },
      );
      return;
    }
    if (!canEditContent(redeemed.role)) {
      reject(
        "403 Forbidden",
        "Insufficient role for collaborative editing",
        `Forbidden: user ${redeemed.username || claims.sub} (role: ${redeemed.role || "none"}) cannot edit`,
        { warn: true },
      );
      return;
    }
    console.log(`👤 Ticket redeemed for user ${redeemed.username} (role: ${redeemed.role}), doc ${docName}`);

    req.auth = {
      sub: claims.sub,
      userId: redeemed.userId,
      username: redeemed.username,
      role: redeemed.role,
    };
    try {
      accept(req, socket, head);
    } catch (error) {
      reject("500 Internal Server Error", "Upgrade failed", `WebSocket handshake failed: ${error.message}`);
    }
  };
}
