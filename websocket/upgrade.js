// The WebSocket upgrade flow: ticket auth + per-document access check + doc-name
// validation (#216, #220, #223, #233, #135).
//
// Extracted from server.js (which boots the server on import) so the ordering
// guarantees are unit tested in upgrade.test.js:
//   1. the credential is taken and stripped from req.url before anything reads it,
//   2. a bad doc name gets 400 before any auth work,
//   3. client context (origin, UA, peer IP) is logged only on rejections.
// Logging is structured (logEvent, #142): ws_upgrade when a request arrives, ws_deny
// with the status and reason when it is refused. Every line carries the request id (a
// proxy's well-formed X-Request-ID, else a new one), which is also forwarded on the access
// lookup and handed to the connection handler as req.auth.requestId. Users are logged
// by id, never by username (#155).
// Dependencies are injected. Must NOT import yjs — see the single-yjs-instance gotcha
// in websocket/CLAUDE.md.
import { isCollabDocName, stripCollabPrefix, takeCredential, ticketIdentity } from "./access.js";
import { docNameForLog, logEvent, requestIdFrom, upgradeContextForLog } from "./logsafe.js";

// Derive the Yjs document name (e.g. "post-2892") from the request URL, the same way
// y-websocket's setupWSConnection does, so we can correlate connection counts.
export const docNameFromReq = (req) => (req.url || "/").slice(1).split("?")[0].split("#")[0];

/**
 * Returns an `upgrade` listener.
 * - verifyTicket(ticket, docName) → the ticket's claims; throws if it is invalid,
 *   expired, not a ticket, or for another doc (→ 401).
 * - consumeTicket(claims) → false if the ticket was already used (→ 401). Burning it
 *   happens before the access lookup, so a ticket can't be retried after a failure.
 * - fetchAccess(identity, docName, { requestId }) → { role, canEdit } from the API's
 *   internal listener (canEditPost: editors any post, contributors their own, #135), or
 *   null if the user or post is gone or the ticket predates a password change (→ 403);
 *   throws if the API can't answer (→ 503). identity is ticketIdentity(claims):
 *   { userId, issuedAt }.
 * - accept(req, socket, head) completes the WebSocket handshake.
 */
export function createUpgradeHandler({ verifyTicket, consumeTicket, fetchAccess, accept }) {
  return async (req, socket, head) => {
    const requestId = requestIdFrom(req.headers?.["x-request-id"]);
    // Node's http server removes its own socket 'error' listener before emitting
    // 'upgrade'. Without this one, a client that disconnects while we await the access
    // lookup (ECONNRESET), or a write to an already-closed peer (EPIPE), is an
    // uncaught 'error' that crashes the process and every live collab session.
    socket.on("error", (err) => {
      logEvent("warn", "ws_socket_error", { request_id: requestId, error: err.code || err.message });
    });
    // The single-use ticket rides in ?ticket= (#233). takeCredential strips it from
    // req.url before anything else reads the request, so nothing below (or y-websocket)
    // can log it (#220). Still never log req.headers; use the logsafe.js views.
    const credential = takeCredential(req);
    stripCollabPrefix(req);
    const rawDocName = docNameFromReq(req);
    const docName = docNameForLog(rawDocName);
    logEvent("info", "ws_upgrade", { request_id: requestId, doc: docName });

    // Rejections log the client context (origin, UA, peer IP) to make them traceable;
    // accepted upgrades don't, so we don't retain that for every editor connect.
    const reject = (status, body, reason, { warn = false, userId } = {}) => {
      logEvent(warn ? "warn" : "error", "ws_deny", {
        request_id: requestId,
        doc: docName,
        status: Number.parseInt(status, 10),
        reason,
        user_id: userId,
        client: upgradeContextForLog(req),
      });
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
    // The verified ticket's user_id (a string claim); identity below validates it.
    const userId = claims.user_id == null ? undefined : String(claims.user_id);

    // Single use: a ticket that leaked (e.g. into a proxy access log) can't open a second
    // socket. Burned before the access lookup, so a failed lookup can't be retried with it;
    // the editor fetches a fresh ticket on every reconnect.
    if (!consumeTicket(claims)) {
      reject("401 Unauthorized", "Invalid or expired ticket", "Ticket already used", { warn: true, userId });
      return;
    }

    // Whether this user may edit this doc is the API's call (canEditPost, #135), from the
    // DB (tickets carry no role claim), asked on its internal listener with the shared
    // secret. The ticket never leaves this process.
    const identity = ticketIdentity(claims);
    if (!identity) {
      reject("403 Forbidden", "Not allowed to edit this document", "Ticket has no valid user_id/iat", { userId });
      return;
    }
    let access;
    try {
      access = await fetchAccess(identity, rawDocName, { requestId });
    } catch (err) {
      reject("503 Service Unavailable", "Could not verify document access", `Access lookup failed: ${err.message}`, { userId });
      return;
    }
    if (!access?.canEdit) {
      reject(
        "403 Forbidden",
        "Not allowed to edit this document",
        `Forbidden: role ${access?.role || "none"} cannot edit this document`,
        { warn: true, userId },
      );
      return;
    }

    req.auth = {
      sub: claims.sub,
      userId: identity.userId,
      username: claims.username,
      role: access.role,
      requestId,
    };
    try {
      accept(req, socket, head);
    } catch (error) {
      reject("500 Internal Server Error", "Upgrade failed", `WebSocket handshake failed: ${error.message}`, { userId });
    }
  };
}
