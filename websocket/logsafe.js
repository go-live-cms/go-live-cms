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
//
// Connection lifecycle events (ws_upgrade, ws_connect, ws_deny, ws_close, …) are written
// by logEvent as one JSON object per line (#142), so they can be parsed alongside the
// Go API's slog output and joined on request_id.

import { randomUUID } from "node:crypto";

export const MAX_LOG_FIELD_LEN = 80;

// Same rule as the API's requestIDPattern (api/observability.go): an incoming
// X-Request-ID is kept only if it can't break a log line, else a fresh one is made.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * The request id for an upgrade or internal request: the X-Request-ID header value if a
 * proxy forwarded a well-formed one, else a new UUID. Pass the header value, not req.
 */
export function requestIdFrom(headerValue) {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value) ? value : randomUUID();
}

/**
 * Writes one structured log line: {"time","level","event",...fields}. Strings are capped
 * at MAX_LOG_FIELD_LEN * 4 (reasons can carry an error message); undefined/null fields
 * are dropped. Only pass values that are safe to log (log-guard.test.js scans the
 * arguments of every logEvent call like a console call).
 */
export function logEvent(level, event, fields = {}) {
  const entry = { time: new Date().toISOString(), level, event };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    entry[key] = typeof value === "string" ? cap(value, MAX_LOG_FIELD_LEN * 4) : value;
  }
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

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
