// The WebSocket upgrade flow: auth + role check + doc-name validation (#216, #220).
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
 * - verifyCredential(credential) → { payload, footer }; throws if the token is invalid.
 * - fetchRole(credential) → the caller's current role (or null); throws if the API
 *   can't answer (→ 503).
 * - accept(req, socket, head) completes the WebSocket handshake.
 */
export function createUpgradeHandler({ verifyCredential, fetchRole, accept }) {
  return async (req, socket, head) => {
    // Node's http server removes its own socket 'error' listener before emitting
    // 'upgrade'. Without this one, a client that disconnects while we await the role
    // lookup (ECONNRESET), or a write to an already-closed peer (EPIPE), is an
    // uncaught 'error' that crashes the process and every live collab session.
    socket.on("error", (err) => {
      console.warn("⚠️  Upgrade socket error:", err.code || err.message);
    });
    // The access token rides in ?ticket= (or ?token=). takeCredential strips it from
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
      reject("401 Unauthorized", "No authentication credentials provided", "No ticket or token provided");
      return;
    }

    let payload, footer;
    try {
      ({ payload, footer } = await verifyCredential(credential));
    } catch (error) {
      reject(
        "401 Unauthorized",
        "Invalid or expired authentication credentials",
        `WebSocket authentication failed: ${error.message}`,
      );
      return;
    }
    console.log("✅ Token verified successfully for user:", payload.sub);
    // The token's `role` claim is informational only (stale on demotion, empty after
    // refresh). Authorization uses the CURRENT role from the API — see access.js.
    console.log("👤 Token role claim (informational):", payload.role || "none");

    let role;
    try {
      role = await fetchRole(credential);
    } catch (err) {
      reject(
        "503 Service Unavailable",
        "Could not verify user role",
        `Role lookup failed for user ${payload.username || payload.sub}: ${err.message}`,
      );
      return;
    }
    if (!canEditContent(role)) {
      reject(
        "403 Forbidden",
        "Insufficient role for collaborative editing",
        `Forbidden: user ${payload.username || payload.sub} (role: ${role || "none"}) cannot edit`,
        { warn: true },
      );
      return;
    }
    console.log("👤 Verified role:", role);

    req.auth = {
      sub: payload.sub,
      username: payload.username,
      role,
      kid: footer?.kid,
      tokenPayload: payload,
    };
    try {
      accept(req, socket, head);
    } catch (error) {
      reject("500 Internal Server Error", "Upgrade failed", `WebSocket handshake failed: ${error.message}`);
    }
  };
}
