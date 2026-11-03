// What the web server's logs share (#378), as plain JS so both sides can load it:
// src/lib/log.ts (bundled by Vite, also into the admin's browser code) and
// server/start.mjs (run by Node as is in the production image, before Astro starts).
// No Node imports here for that reason.

// The query (and fragment) of any absolute URL inside a string, e.g. an error message.
const URL_QUERY = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>`]*)[?#][^\s"'<>`]*/gi
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi
// Terminal colours (Astro's logger adds them when it thinks it may).
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g
const MAX_STRING = 8192

/**
 * A string as it may be logged: without URL query strings, bearer tokens or colour
 * codes, and at most 8 KiB.
 * @param {string} s
 * @returns {string}
 */
export function scrubText(s) {
  const cleaned = s.replace(ANSI, "").replace(URL_QUERY, "$1").replace(BEARER, "Bearer [REDACTED]")
  return cleaned.length > MAX_STRING ? `${cleaned.slice(0, MAX_STRING)}…(+${cleaned.length - MAX_STRING})` : cleaned
}

// The current request's {request_id, route}. A global, not a module variable: the
// bundled log.ts and start.mjs each load their own copy of this module.
const CONTEXT = Symbol.for("golive.web.logContext")

/** @param {() => ({request_id?: string, route?: string} | undefined)} source */
export function setLogContextSource(source) {
  globalThis[CONTEXT] = source
}

/** @returns {{request_id?: string, route?: string} | undefined} */
export function currentLogContext() {
  try {
    return globalThis[CONTEXT]?.()
  } catch {
    return undefined
  }
}

const CONSOLE_LEVELS = { log: "info", info: "info", warn: "warn", error: "error", debug: "debug", trace: "debug" }

function argText(arg) {
  if (typeof arg === "string") return arg
  if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`
  try {
    return JSON.stringify(arg) ?? String(arg)
  } catch {
    return String(arg)
  }
}

/**
 * One console call as a log line: {time, level, msg: "console", request_id, route, text}.
 * A call that already wrote one JSON object is kept as it is.
 * @param {keyof typeof CONSOLE_LEVELS} method
 * @param {unknown[]} args
 * @param {Date} [now]
 * @returns {string}
 */
export function consoleRecord(method, args, now = new Date()) {
  const text = args.map(argText).join(" ")
  const trimmed = text.trim()
  if (trimmed.startsWith("{") && !trimmed.includes("\n")) {
    try {
      if (JSON.parse(trimmed)?.level) return trimmed
    } catch {
      // Not JSON: wrap it like any other text.
    }
  }
  const context = currentLogContext()
  const record = { time: now.toISOString(), level: CONSOLE_LEVELS[method] ?? "info", msg: "console" }
  if (context?.request_id) record.request_id = context.request_id
  if (context?.route) record.route = context.route
  record.text = scrubText(text.replace(/\s+$/, ""))
  return JSON.stringify(record)
}

/**
 * Routes every console call through consoleRecord, for output nothing else formats:
 * Astro's own logger (the startup banner, a page's uncaught error with its stack) and
 * dependencies. Debug calls are dropped (production only). src/lib/log.ts writes to
 * the streams directly, so its lines don't pass through here.
 * @param {{ write(chunk: string): unknown }} stdout
 * @param {{ write(chunk: string): unknown }} stderr
 */
export function installConsoleJson(stdout, stderr) {
  for (const method of Object.keys(CONSOLE_LEVELS)) {
    const level = CONSOLE_LEVELS[method]
    console[method] = (...args) => {
      if (level === "debug") return
      const stream = level === "warn" || level === "error" ? stderr : stdout
      stream.write(`${consoleRecord(method, args)}\n`)
    }
  }
}
