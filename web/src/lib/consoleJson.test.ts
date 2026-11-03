import { EventEmitter } from "node:events"
import { format } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { consoleRecord, installConsoleJson, installProcessJson, scrubText } from "../../server/logFormat.mjs"
import { runWithLogContext } from "../middleware/requestContext"

const NOW = new Date("2026-11-02T12:00:00.000Z")

// server/start.mjs: what Astro and dependencies write to the console in production.
describe("consoleRecord", () => {
  it("wraps a multi-line message, e.g. Astro's error with its stack, in one JSON line", () => {
    const astroError = "\x1b[31m12:00:00 [ERROR]\x1b[39m Error: boom\n    at render (file:///app/dist/server/chunks/x.mjs:1:2)\n"
    const line = consoleRecord("error", [astroError], NOW)
    expect(line).not.toContain("\n")
    expect(JSON.parse(line)).toEqual({
      time: NOW.toISOString(),
      level: "error",
      msg: "console",
      text: "12:00:00 [ERROR] Error: boom\n    at render (file:///app/dist/server/chunks/x.mjs:1:2)",
    })
  })

  it("maps console methods to levels and formats errors and objects", () => {
    expect(JSON.parse(consoleRecord("info", ["Server listening on", { port: 4321 }], NOW))).toMatchObject({ level: "info", text: 'Server listening on {"port":4321}' })
    expect(JSON.parse(consoleRecord("log", ["x"], NOW)).level).toBe("info")
    expect(JSON.parse(consoleRecord("warn", ["x"], NOW)).level).toBe("warn")
    const record = JSON.parse(consoleRecord("error", ["failed:", new TypeError("fetch failed")], NOW))
    expect(record.text).toMatch(/^failed: TypeError: fetch failed\n\s+at /)
  })

  it("keeps a line that is already a JSON record, scrubbed", () => {
    const own = '{"time":"t","level":"warn","event":"collab_reconnect"}'
    expect(consoleRecord("log", [own], NOW)).toBe(own)
    const leaky = '{"level":"warn","url":"http://api:8080/x?token=abc","auth":"Bearer abc.def","token":"abc","headers":{"Cookie":"a=b"}}'
    expect(JSON.parse(consoleRecord("log", [leaky], NOW))).toEqual({
      level: "warn",
      url: "http://api:8080/x",
      auth: "Bearer [REDACTED]",
      token: "[REDACTED]",
      headers: { Cookie: "[REDACTED]" },
    })
  })

  it("applies format specifiers with the formatter it is given", () => {
    expect(JSON.parse(consoleRecord("warn", ["%s failed after %dms", "menu", 120], NOW, format)).text).toBe("menu failed after 120ms")
  })

  it("strips query strings and tokens and carries the request context", () => {
    const record = runWithLogContext({ request_id: "req-12345678", route: "/search" }, () =>
      JSON.parse(consoleRecord("warn", ["GET http://api:8080/public/search?q=private with Bearer abc.def"], NOW)),
    )
    expect(record).toMatchObject({ request_id: "req-12345678", route: "/search", text: "GET http://api:8080/public/search with Bearer [REDACTED]" })
    expect(scrubText("wss://h/collab?epoch=9#x")).toBe("wss://h/collab")
  })
})

describe("installConsoleJson", () => {
  const saved = { ...console }
  afterEach(() => Object.assign(console, saved))

  it("sends every console call to the streams as JSON lines, and drops debug", () => {
    const out: string[] = []
    const err: string[] = []
    installConsoleJson({ write: (s: string) => out.push(s) }, { write: (s: string) => err.push(s) })
    console.log("a")
    console.info("b\nc")
    console.debug("dropped")
    console.dir({ x: 1 }, { depth: 5 })
    console.warn("d")
    console.error(new Error("e"))
    Object.assign(console, saved)

    expect(out.map((s) => JSON.parse(s).text)).toEqual(["a", "b\nc", '{"x":1}'])
    expect(err.map((s) => JSON.parse(s).level)).toEqual(["warn", "error"])
    for (const s of [...out, ...err]) expect(s.endsWith("\n") && !s.slice(0, -1).includes("\n")).toBe(true)
  })
})

describe("installProcessJson", () => {
  const saved = { ...console }
  afterEach(() => Object.assign(console, saved))

  it("logs process warnings and crashes as one record each, and still exits 1 on a crash", () => {
    const proc = new EventEmitter() as EventEmitter & { exit: (code: number) => void; exitCode?: number }
    proc.on("warning", () => {
      throw new Error("Node's own printer should be gone")
    })
    proc.exit = (code: number) => {
      proc.exitCode = code
    }
    const err: string[] = []
    installConsoleJson({ write: () => {} }, { write: (s: string) => err.push(s) }, format)
    installProcessJson(proc)

    proc.emit("warning", new Error("Possible EventEmitter memory leak"))
    expect(proc.exitCode).toBeUndefined()
    proc.emit("uncaughtException", new Error("boom"))
    Object.assign(console, saved)

    expect(proc.exitCode).toBe(1)
    expect(err.map((s) => JSON.parse(s))).toMatchObject([
      { level: "warn", text: expect.stringMatching(/^Error: Possible EventEmitter memory leak\n\s+at /) },
      { level: "error", text: expect.stringMatching(/^uncaught exception: Error: boom\n\s+at /) },
    ])
  })
})
