import { describe, expect, it } from "vitest"
import { createLogger, safeUrl, type LogContext, type LogFields, type LogLevel } from "./log"
import { requestIdFrom, runWithLogContext } from "../middleware/requestContext"

const NOW = new Date("2026-11-02T12:00:00.000Z")

// A logger that collects its lines, with the default context source (the middleware's)
// unless one is given.
function capture(options: { debug?: boolean; context?: () => LogContext | undefined } = {}) {
  const lines: Array<{ level: LogLevel; line: string }> = []
  const logger = createLogger({
    write: (level: LogLevel, line: string, _msg: string, _fields: LogFields) => lines.push({ level, line }),
    now: () => NOW,
    debug: options.debug ?? false,
    ...(options.context ? { context: options.context } : {}),
  })
  const records = () => lines.map(({ line }) => JSON.parse(line))
  return { logger, lines, records }
}

describe("log", () => {
  it("writes one JSON object per record, on one line", () => {
    const { logger, lines, records } = capture()
    logger.info("menu_loaded", { location: "primary", items: 3, note: "two\nlines" })
    logger.warn("menu_fetch_failed", { location: "footer" })

    expect(lines).toHaveLength(2)
    for (const { line } of lines) expect(line).not.toContain("\n")
    expect(records()).toEqual([
      { time: NOW.toISOString(), level: "info", msg: "menu_loaded", location: "primary", items: 3, note: "two\nlines" },
      { time: NOW.toISOString(), level: "warn", msg: "menu_fetch_failed", location: "footer" },
    ])
    expect(lines.map((l) => l.level)).toEqual(["info", "warn"])
  })

  it("serializes an error on the same line, with its stack, status and cause in fields", () => {
    const { logger, lines, records } = capture()
    const cause = Object.assign(new Error("connect ECONNREFUSED 172.28.0.12:8080"), { code: "ECONNREFUSED" })
    const error = Object.assign(new TypeError("fetch failed", { cause }), { status: 502 })
    logger.error("post_fetch_failed", { post_type: "post", error })

    expect(lines).toHaveLength(1)
    expect(lines[0].line).not.toContain("\n")
    const [record] = records()
    expect(record).toMatchObject({
      level: "error",
      msg: "post_fetch_failed",
      post_type: "post",
      error: "fetch failed",
      error_type: "TypeError",
      status: 502,
      cause: "Error: connect ECONNREFUSED 172.28.0.12:8080 (ECONNREFUSED)",
    })
    expect(record.stack).toContain("TypeError: fetch failed")
    expect(record.stack).toMatch(/\n\s+at /)
    // Anything else thrown is kept: an object as is, the rest as text.
    logger.error("odd_failure", { error: { reason: "x" } })
    logger.error("odd_failure", { error: 42 })
    expect(records()[1].error).toEqual({ reason: "x" })
    expect(records()[2].error).toBe("42")
  })

  it("keeps the record's own keys", () => {
    const { logger, records } = capture()
    logger.info("x", { msg: "spoofed", level: "debug", time: "then", request_id: "fake-id-1", route: "/x" })
    expect(records()[0]).toEqual({ time: NOW.toISOString(), level: "info", msg: "x" })
  })

  it("strips query strings from URLs, in URL fields and inside any text", () => {
    const { logger, records } = capture()
    logger.warn("fetch_failed", {
      url: "http://api:8080/api/v1/posts?status=draft&token=abc#frag",
      path: "/search/page/2/?q=private+words",
      upstream_url: new URL("https://example.com/a/b?x=1"),
      error: new Error("GET http://api:8080/public/search?q=secret failed"),
      note: "see https://example.com/x?y=1 and wss://h/collab?epoch=9",
    })
    const [record] = records()
    expect(record.url).toBe("http://api:8080/api/v1/posts")
    expect(record.path).toBe("/search/page/2/")
    expect(record.upstream_url).toBe("https://example.com/a/b")
    expect(record.error).toBe("GET http://api:8080/public/search failed")
    expect(record.stack).not.toContain("q=secret")
    expect(record.note).toBe("see https://example.com/x and wss://h/collab")
    expect(JSON.stringify(record)).not.toMatch(/token=|epoch=|private|frag/)

    expect(safeUrl("https://example.com/p?q=1")).toBe("https://example.com/p")
    expect(safeUrl("/a?b")).toBe("/a")
    expect(safeUrl("http://[bad")).toBe("(invalid url)")
  })

  it("blanks credential-looking fields and bearer tokens", () => {
    const { logger, records } = capture()
    logger.warn("auth_failed", {
      authorization: "Bearer abc.def",
      headers: { Cookie: "refresh_token=x", accept: "text/html" },
      auth_token: "abc",
      note: "sent Bearer eyJhbGciOi.payload.sig upstream",
    })
    const [record] = records()
    expect(record.authorization).toBe("[REDACTED]")
    expect(record.auth_token).toBe("[REDACTED]")
    expect(record.headers).toEqual({ Cookie: "[REDACTED]", accept: "text/html" })
    expect(record.note).toBe("sent Bearer [REDACTED] upstream")
  })

  it("drops debug records unless debug is on", () => {
    const off = capture({ debug: false })
    off.logger.debug("blocks_registered", { count: 9 })
    off.logger.info("kept")
    expect(off.records().map((r) => r.msg)).toEqual(["kept"])

    const on = capture({ debug: true })
    on.logger.debug("blocks_registered", { count: 9 })
    expect(on.records()[0]).toMatchObject({ level: "debug", msg: "blocks_registered", count: 9 })
  })

  it("survives a field it can't serialize", () => {
    const { logger, records } = capture()
    const loop: Record<string, unknown> = {}
    loop.self = loop
    logger.error("weird", { loop })
    expect(records()[0]).toMatchObject({ level: "error", msg: "weird", log_error: "unserializable fields" })
  })
})

describe("request context", () => {
  it("carries the request id and route into every record logged while the request runs", async () => {
    const { logger, records } = capture()
    logger.info("before")
    await runWithLogContext({ request_id: "req-12345678", route: "/[post_type]/[id]" }, async () => {
      logger.info("start")
      await new Promise((resolve) => setTimeout(resolve, 1))
      await Promise.all([Promise.resolve().then(() => logger.warn("in_parallel"))])
    })
    logger.info("after")

    expect(records().map((r) => [r.msg, r.request_id, r.route])).toEqual([
      ["before", undefined, undefined],
      ["start", "req-12345678", "/[post_type]/[id]"],
      ["in_parallel", "req-12345678", "/[post_type]/[id]"],
      ["after", undefined, undefined],
    ])
  })

  it("keeps concurrent requests apart", async () => {
    const { logger, records } = capture()
    const handle = (id: string, delay: number) =>
      runWithLogContext({ request_id: id, route: "/" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delay))
        logger.info("done", { id })
      })
    await Promise.all([handle("request-a-1", 5), handle("request-b-1", 1)])
    for (const record of records()) expect(record.request_id).toBe(record.id)
  })

  it("takes a well-formed X-Request-ID and makes one up otherwise", () => {
    const caddy = "0d8c2b2e-6c1a-4c2f-9d55-0f6a3c1d2e4f"
    expect(requestIdFrom(new Headers({ "X-Request-ID": caddy }))).toBe(caddy)
    for (const bad of [undefined, "short", "has spaces in it", "x".repeat(129), '"},{"level":"error"']) {
      const headers = new Headers(bad === undefined ? {} : { "X-Request-ID": bad })
      const id = requestIdFrom(headers)
      expect(id).not.toBe(bad)
      expect(id).toMatch(/^[0-9a-f-]{36}$/)
    }
  })
})
