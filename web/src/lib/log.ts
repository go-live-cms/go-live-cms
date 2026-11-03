// Structured logs for the web (Astro) server (#378), like the API's slog JSON and the
// collab server's logEvent: one JSON object per line,
//
//   {"time":"…","level":"warn","msg":"menu_fetch_failed","request_id":"…","route":"/[post_type]/[id]","location":"primary","error":"…","stack":"…"}
//
// so a log shipper can parse it and a web line can be tied to the API's by request_id.
// The same rules as api/CLAUDE.md (Observability): never log headers, cookies, tokens,
// passwords or raw query strings. Pass a URL through `safeUrl`, log routes by their
// pattern, and keep `msg` a fixed snake_case name with the variable parts in fields.
// As a backstop, every string has its URLs' query strings removed and every field whose
// name looks like a credential is blanked.
//
// Safe to import from code the admin also runs in the browser (block registry,
// BlockRenderer): there it logs to the console as before, without JSON. The request
// context comes from src/middleware/requestContext.ts, which owns the AsyncLocalStorage;
// this module has no Node imports. Anything else that writes to the console in
// production (Astro itself) is wrapped by server/start.mjs with the same scrubbing.

import { currentLogContext, isSensitiveKey, scrubText, setLogContextSource } from "../../server/logFormat.mjs"

export type LogLevel = "debug" | "info" | "warn" | "error"
export type LogFields = Record<string, unknown>

export interface LogContext {
  request_id?: string
  route?: string
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  error(msg: string, fields?: LogFields): void
}

export interface LoggerOptions {
  // Receives each finished line (no trailing newline). Default: stdout, or stderr for
  // warn/error, on the server; the console in a browser.
  write?: (level: LogLevel, line: string, msg: string) => void
  // Whether debug records are written. Default: only in `astro dev`, never in the
  // production build (or vitest).
  debug?: boolean
  now?: () => Date
  // The current request's id and route. Default: the middleware's (setLogContextSource).
  context?: () => LogContext | undefined
}

// Called once by the middleware's request context module.
export { setLogContextSource }

// A field holding a URL or path gets its query removed even when it isn't absolute.
const URL_KEY = /^(url|uri|path|href|endpoint)$|_(url|uri|path)$/i
// Keys the record itself owns: a field can't overwrite them.
const RESERVED = new Set(["time", "level", "msg", "request_id", "route"])

// A URL without its query string or fragment: the origin and path of an absolute URL,
// the path of a relative one. Anything unparsable becomes "(invalid url)".
export function safeUrl(value: unknown): string {
  if (value instanceof URL) return value.origin + value.pathname
  const s = String(value ?? "")
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    try {
      const url = new URL(s)
      return url.origin === "null" ? `${url.protocol}${url.pathname}` : url.origin + url.pathname
    } catch {
      return "(invalid url)"
    }
  }
  return s.replace(/[?#].*$/s, "")
}

// An error as fields of the record: its message, type, status (apiCall's errors carry the
// API's) and cause (Node's fetch says only "fetch failed"; the cause has ECONNREFUSED),
// and the whole stack as one string, so the record stays on one line.
function errorFields(error: unknown): LogFields {
  // Something thrown that isn't an Error: an object as is (the replacer still checks it).
  if (!(error instanceof Error)) return { error: typeof error === "object" && error !== null ? error : String(error) }
  const fields: LogFields = { error: error.message, error_type: error.name }
  const status = (error as { status?: unknown }).status
  if (typeof status === "number") fields.status = status
  const cause = (error as { cause?: unknown }).cause
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code
    fields.cause = `${cause.name}: ${cause.message}${typeof code === "string" ? ` (${code})` : ""}`
  } else if (cause !== undefined) {
    fields.cause = String(cause)
  }
  if (error.stack) fields.stack = error.stack
  return fields
}

function replacer(this: unknown, key: string, value: unknown): unknown {
  if (key && isSensitiveKey(key)) return "[REDACTED]"
  if (value instanceof Error) return errorFields(value)
  // A URL object arrives here as its href (URL#toJSON), so URL fields are strings too.
  if (typeof value === "string") return scrubText(key && URL_KEY.test(key) ? safeUrl(value) : value)
  if (typeof value === "bigint") return value.toString()
  return value
}

export function formatRecord(level: LogLevel, msg: string, fields: LogFields, context: LogContext | undefined, now: Date): string {
  const record: LogFields = { time: now.toISOString(), level, msg }
  if (context?.request_id) record.request_id = context.request_id
  if (context?.route) record.route = context.route
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || RESERVED.has(key)) continue
    // `error` is flattened into the record: error, error_type, status, cause, stack.
    if (key === "error") {
      for (const [k, v] of Object.entries(errorFields(value))) if (!(k in record)) record[k] = v
      continue
    }
    record[key] = value
  }
  try {
    return JSON.stringify(record, replacer)
  } catch {
    // A circular or otherwise unserializable field: keep the record, drop the fields.
    return JSON.stringify({ time: record.time, level, msg, request_id: record.request_id, route: record.route, log_error: "unserializable fields" }, replacer)
  }
}

function defaultWrite(level: LogLevel, line: string, msg: string): void {
  const proc = (globalThis as { process?: { stdout?: { write?: unknown }; stderr?: { write?: unknown } } }).process
  const stream = level === "warn" || level === "error" ? proc?.stderr : proc?.stdout
  if (typeof stream?.write === "function") {
    ;(stream.write as (chunk: string) => void)(`${line}\n`)
    return
  }
  // Browser (shared code in the admin): the console shows objects better than JSON. The
  // record, not the raw fields, so the same redaction applies.
  console[level](msg, JSON.parse(line))
}

// Headers for a server-side call to the API: this request's id, so the API logs the call
// under the same request_id as the web's lines (it keeps an incoming id only from
// TRUSTED_PROXIES, which lists the web container). Empty outside a request and in the
// browser.
export function requestIdHeaders(): Record<string, string> {
  const id = currentLogContext()?.request_id
  return id ? { "X-Request-ID": id } : {}
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const write = options.write ?? defaultWrite
  const debug = options.debug ?? Boolean(import.meta.env?.DEV && import.meta.env.MODE !== "test")
  const now = options.now ?? (() => new Date())
  const context = options.context ?? currentLogContext

  const emit = (level: LogLevel, msg: string, fields: LogFields = {}) => {
    if (level === "debug" && !debug) return
    write(level, formatRecord(level, msg, fields, context(), now()), msg)
  }
  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
  }
}

export const log: Logger = createLogger()
