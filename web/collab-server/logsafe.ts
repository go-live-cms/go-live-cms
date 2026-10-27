// Log-safe helpers for the collab server, ported from the old y-websocket server (#220, #142).
//
// Nothing here may log a ticket, the request URL or headers. These helpers build the
// only request context that gets logged: the doc name plus an allowlist of non-secret
// fields. All of it is attacker-controlled and may be logged before authentication, so
// every value is length-capped and escaped so it can't flood the logs or forge a line.
//
// Connection lifecycle events (ws_connect, ws_deny, ws_close, …) are written by logEvent
// as one JSON object per line (#142), so they can be parsed alongside the Go API's slog
// output and joined on request_id. log-guard.test.ts scans every log call in this
// directory. Must NOT import yjs.

import { randomUUID } from "node:crypto"
import type { IncomingHttpHeaders } from "node:http"

export const MAX_LOG_FIELD_LEN = 80

// Same rule as the API's requestIDPattern (api/observability.go): an incoming
// X-Request-ID is kept only if it can't break a log line, else a fresh one is made.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/

/**
 * The request id for a connection or internal request: the X-Request-ID header value if
 * a proxy forwarded a well-formed one, else a new UUID. Pass the header value, not the
 * request.
 */
export function requestIdFrom(headerValue: string | string[] | undefined): string {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value) ? value : randomUUID()
}

export type LogLevel = "debug" | "info" | "warn" | "error"

/**
 * Writes one structured log line: {"time","level","event",...fields}. Strings are capped
 * at MAX_LOG_FIELD_LEN * 4 (reasons can carry an error message); undefined/null fields
 * are dropped. Only pass values that are safe to log (log-guard.test.ts scans the
 * arguments of every logEvent call like a console call).
 */
export function logEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const entry: Record<string, unknown> = { time: new Date().toISOString(), level, event }
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue
    entry[key] = typeof value === "string" ? cap(value, MAX_LOG_FIELD_LEN * 4) : value
  }
  const line = JSON.stringify(entry)
  if (level === "error") console.error(line)
  else if (level === "warn") console.warn(line)
  else console.log(line)
}

function cap(s: string, maxLen: number): string {
  return s.length > maxLen ? `${s.slice(0, maxLen)}…(+${s.length - maxLen})` : s
}

// Doc names are "post-<id>"; anything outside a conservative charset becomes "?" so a
// crafted name can't inject spaces, separators or fake log text.
export function docNameForLog(docName: unknown, maxLen = MAX_LOG_FIELD_LEN): string {
  const s = String(docName ?? "")
  if (!s) return "(none)"
  return cap(s.replace(/[^A-Za-z0-9._:-]/g, "?"), maxLen)
}

// Non-secret client context for debugging rejected connections: origin, user agent and
// the peer address. Values are JSON-quoted so their content can't be mistaken for log
// structure. X-Forwarded-For is deliberately left out (spoofable).
export function clientContextForLog(
  headers: IncomingHttpHeaders | undefined,
  peer: string | undefined,
  maxLen = MAX_LOG_FIELD_LEN,
): string {
  const fields: Record<string, unknown> = {
    origin: headers?.origin,
    ua: headers?.["user-agent"],
    peer,
  }
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${value ? JSON.stringify(cap(String(value), maxLen)) : "-"}`)
    .join(" ")
}

/** An error's message, for a log field (never the error object: it may carry a request). */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
