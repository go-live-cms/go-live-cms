import { describe, it, expect, vi, beforeAll, afterAll } from "vitest"
import type { AddressInfo } from "node:net"
import type { Server } from "node:http"
import { bearerMatches, createInternalServer, type FlushResult } from "./internal"

const SECRET = "flush-secret"
let server: Server
let base: string
const flush = vi.fn(async (_doc: string): Promise<FlushResult> => ({ ok: true, skipped: false, loaded: true }))

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
  server = createInternalServer({ secret: SECRET, flush })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => {
  server.close()
  vi.restoreAllMocks()
})

const post = (path: string, auth?: string) =>
  fetch(`${base}${path}`, { method: "POST", headers: auth ? { Authorization: auth } : {} })

describe("internal listener", () => {
  it("bearerMatches is exact and refuses an empty secret", () => {
    expect(bearerMatches(`Bearer ${SECRET}`, SECRET)).toBe(true)
    expect(bearerMatches(` Bearer ${SECRET} `, SECRET)).toBe(true)
    expect(bearerMatches(`Bearer ${SECRET}x`, SECRET)).toBe(false)
    expect(bearerMatches(SECRET, SECRET)).toBe(false)
    expect(bearerMatches(undefined, SECRET)).toBe(false)
    expect(bearerMatches("Bearer ", "")).toBe(false)
  })

  it("healthz needs no secret", async () => {
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it("flush requires the shared secret", async () => {
    flush.mockClear()
    expect((await post("/internal/documents/post-12/flush")).status).toBe(401)
    expect((await post("/internal/documents/post-12/flush", "Bearer wrong")).status).toBe(401)
    expect(flush).not.toHaveBeenCalled()
  })

  it("flushes a valid doc and reports whether anything was stored", async () => {
    flush.mockClear()
    const res = await post("/internal/documents/post-12/flush", `Bearer ${SECRET}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ flushed: true })
    expect(flush).toHaveBeenCalledWith("post-12")

    flush.mockResolvedValueOnce({ ok: true, skipped: true, loaded: false })
    expect(await (await post("/internal/documents/post-7/flush", `Bearer ${SECRET}`)).json()).toEqual({ flushed: false })
  })

  it("answers 503 when the store fails, so publish doesn't go ahead", async () => {
    flush.mockResolvedValueOnce({ ok: false, error: "collab store failed: API responded 500" })
    expect((await post("/internal/documents/post-12/flush", `Bearer ${SECRET}`)).status).toBe(503)
    flush.mockRejectedValueOnce(new Error("boom"))
    expect((await post("/internal/documents/post-12/flush", `Bearer ${SECRET}`)).status).toBe(503)
  })

  it("refuses bad doc names, wrong methods and unknown paths", async () => {
    flush.mockClear()
    expect((await post("/internal/documents/post-0/flush", `Bearer ${SECRET}`)).status).toBe(400)
    expect((await post("/internal/documents/%E0%A4%A/flush", `Bearer ${SECRET}`)).status).toBe(400)
    expect((await fetch(`${base}/internal/documents/post-12/flush`, { headers: { Authorization: `Bearer ${SECRET}` } })).status).toBe(405)
    expect((await post("/internal/documents/post-12/squash", `Bearer ${SECRET}`)).status).toBe(404)
    expect(flush).not.toHaveBeenCalled()
  })
})
