// Log-safe views of WebSocket upgrade requests (#220).
//
// The editor's access token rides in the upgrade URL (?ticket= / ?token=), so nothing
// may log req.url, req.headers or the query string. These helpers build the only
// request context that gets logged: the doc name plus an allowlist of non-secret
// fields. All of it is attacker-controlled and may be logged before authentication, so
// every value is length-capped and escaped so it can't flood the logs or forge a line.
//
// Pure, so it's unit tested in logsafe.test.js (and log-guard.test.js checks that no
// module logs the raw request). Must NOT import yjs — see the single-yjs-instance
// gotcha in websocket/CLAUDE.md.

export const MAX_LOG_FIELD_LEN = 80;

function cap(s, maxLen) {
  return s.length > maxLen ? `${s.slice(0, maxLen)}…(+${s.length - maxLen})` : s;
}

// Doc names are "post-<id>"; anything outside a conservative charset becomes "?" so a
// crafted path can't inject spaces, separators or fake log text.
export function docNameForLog(docName, maxLen = MAX_LOG_FIELD_LEN) {
  const s = String(docName ?? "");
  if (!s) return "(none)";
  return cap(s.replace(/[^A-Za-z0-9._:-]/g, "?"), maxLen);
}

// Non-secret request context for debugging rejected upgrades: origin, user agent and
// the socket's peer address. Values are JSON-quoted so their content can't be
// mistaken for log structure. X-Forwarded-For is deliberately left out (spoofable).
export function upgradeContextForLog(req, maxLen = MAX_LOG_FIELD_LEN) {
  const headers = req?.headers || {};
  const fields = {
    origin: headers.origin,
    ua: headers["user-agent"],
    peer: req?.socket?.remoteAddress,
  };
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${value ? JSON.stringify(cap(String(value), maxLen)) : "-"}`)
    .join(" ");
}
