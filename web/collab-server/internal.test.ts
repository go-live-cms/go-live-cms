import { describe, it, expect, vi, beforeAll, afterAll } from "vitest"
import type { AddressInfo } from "node:net"
import type { Server } from "node:http"
import { bearerMatches, createInternalServer, RESTORE_BODY_LIMIT, type FlushResult, type RestoreResult } from "./internal"

const SECRET = "flush-secret"
let server: Server
let base: string
const flush = vi.fn(async (_doc: string): Promise<FlushResult> => ({ ok: true, skipped: false, loaded: true }))
const recheckUser = vi.fn((_userId: string) => 2)
const recheckDoc = vi.fn((_docName: string) => 3)
const notifyComments = vi.fn((_docName: string) => 4)
const restore = vi.fn(
  async (_doc: string, _version: unknown, _opts: { userId: string; requestId?: string }): Promise<RestoreResult> => ({
    ok: true,
    revision: 5,
    block_doc: "written",
    dropped: 1,
  }),
)

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
  server = createInternalServer({ secret: SECRET, flush, recheckUser, recheckDoc, notifyComments, restore })
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
  it("comments: the nudge needs the secret and a doc name (#192)", async () => {
    expect((await post("/internal/documents/post-7/comments")).status).toBe(401)
    expect((await post("/internal/documents/post-7/comments", "Bearer wrong")).status).toBe(401)
    expect((await post("/internal/documents/nope/comments", `Bearer ${SECRET}`)).status).toBe(400)
    expect((await post("/internal/documents/%E0%A4%A/comments", `Bearer ${SECRET}`)).status).toBe(400)
    expect((await fetch(`${base}/internal/documents/post-7/comments`, { headers: { Authorization: `Bearer ${SECRET}` } })).status).toBe(405)
    expect(notifyComments).not.toHaveBeenCalled()

    const res = await post("/internal/documents/post-7/comments", `Bearer ${SECRET}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ connections: 4 })
    expect(notifyComments).toHaveBeenCalledWith("post-7")
  })

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
    expect((await post("/internal/documents/post-12/unknown", `Bearer ${SECRET}`)).status).toBe(404)
    expect(flush).not.toHaveBeenCalled()
  })

  it("re-checks a user's connections on request (#333), with the secret only", async () => {
    recheckUser.mockClear()
    expect((await post("/internal/users/7/recheck")).status).toBe(401)
    expect((await post("/internal/users/7/recheck", "Bearer wrong")).status).toBe(401)
    expect(recheckUser).not.toHaveBeenCalled()

    const res = await post("/internal/users/7/recheck", `Bearer ${SECRET}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ docs: 2 })
    expect(recheckUser).toHaveBeenCalledWith("7")

    for (const bad of ["0", "abc", "-1", "1e3", "12345678901234567890"]) {
      expect((await post(`/internal/users/${bad}/recheck`, `Bearer ${SECRET}`)).status).toBe(400)
    }
    expect((await fetch(`${base}/internal/users/7/recheck`, { headers: { Authorization: `Bearer ${SECRET}` } })).status).toBe(405)
    expect(recheckUser).toHaveBeenCalledTimes(1)
  })
})

describe("restore (#286)", () => {
  const version = { doc_version: 1, blocks_order: [], blocks: {} }
  const restoreRequest = (path: string, body: unknown, auth: string | null = `Bearer ${SECRET}`) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-ID": "restore-req-1", ...(auth !== null ? { Authorization: auth } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })

  it("needs the secret, a post's doc name, a user id and a block_doc", async () => {
    restore.mockClear()
    expect((await restoreRequest("/internal/documents/post-12/restore", { block_doc: version, user_id: "7" }, null)).status).toBe(401)
    expect((await restoreRequest("/internal/documents/post-12/restore", { block_doc: version, user_id: "7" }, "Bearer wrong")).status).toBe(401)
    for (const bad of ["post-0", "settings", "%E0%A4%A"]) {
      expect((await restoreRequest(`/internal/documents/${bad}/restore`, { block_doc: version, user_id: "7" })).status).toBe(400)
    }
    expect((await restoreRequest("/internal/documents/post-12/restore", "{not json")).status).toBe(400)
    expect((await restoreRequest("/internal/documents/post-12/restore", "[]")).status).toBe(400)
    expect((await restoreRequest("/internal/documents/post-12/restore", { block_doc: version })).status).toBe(400)
    expect((await restoreRequest("/internal/documents/post-12/restore", { block_doc: version, user_id: "0" })).status).toBe(400)
    expect((await restoreRequest("/internal/documents/post-12/restore", { user_id: "7" })).status).toBe(400)
    expect((await fetch(`${base}/internal/documents/post-12/restore`, { headers: { Authorization: `Bearer ${SECRET}` } })).status).toBe(405)
    expect(restore).not.toHaveBeenCalled()
  })

  it("restores and answers what it did", async () => {
    restore.mockClear()
    const res = await restoreRequest("/internal/documents/post-12/restore", { block_doc: version, user_id: 7 })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ restored: true, revision: 5, block_doc: "written", dropped: 1 })
    expect(restore).toHaveBeenCalledWith("post-12", version, { userId: "7", requestId: "restore-req-1" })
  })

  it("maps each refusal to its status, and a throw to 503", async () => {
    for (const [reason, status] of [
      ["not-a-post", 400],
      ["invalid-version", 400],
      ["not-found", 404],
      ["unstorable", 422],
      ["unavailable", 503],
    ] as const) {
      restore.mockResolvedValueOnce({ ok: false, reason, error: "internal detail" })
      const res = await restoreRequest("/internal/documents/post-12/restore", { block_doc: version, user_id: "7" })
      expect(res.status).toBe(status)
      const body = (await res.json()) as { reason: string; error: string }
      expect(body.reason).toBe(reason)
      // The internal error stays in the collab log.
      expect(body.error).not.toContain("internal detail")
    }
    restore.mockRejectedValueOnce(new Error("boom"))
    expect((await restoreRequest("/internal/documents/post-12/restore", { block_doc: version, user_id: "7" })).status).toBe(503)
  })

  it("refuses a body over the limit without calling restore", async () => {
    restore.mockClear()
    const huge = JSON.stringify({ user_id: "7", block_doc: { pad: "x".repeat(RESTORE_BODY_LIMIT) } })
    const res = await restoreRequest("/internal/documents/post-12/restore", huge).catch(() => null)
    // The listener may close the socket while the body is still being sent.
    if (res) expect(res.status).toBe(413)
    expect(restore).not.toHaveBeenCalled()
  })
})

describe("document re-check (#327)", () => {
  it("re-checks a document's connections on request, with the secret only", async () => {
    recheckDoc.mockClear()
    expect((await post("/internal/documents/post-12/recheck")).status).toBe(401)
    expect((await post("/internal/documents/post-12/recheck", "Bearer wrong")).status).toBe(401)
    expect(recheckDoc).not.toHaveBeenCalled()

    const res = await post("/internal/documents/post-12/recheck", `Bearer ${SECRET}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ docs: 3 })
    expect(recheckDoc).toHaveBeenCalledWith("post-12")

    for (const bad of ["post-0", "settings", "%E0%A4%A"]) {
      expect((await post(`/internal/documents/${bad}/recheck`, `Bearer ${SECRET}`)).status).toBe(400)
    }
    expect((await fetch(`${base}/internal/documents/post-12/recheck`, { headers: { Authorization: `Bearer ${SECRET}` } })).status).toBe(405)
    expect(recheckDoc).toHaveBeenCalledTimes(1)
  })
})
