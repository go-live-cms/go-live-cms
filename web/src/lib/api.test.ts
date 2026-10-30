import { afterEach, describe, expect, it, vi } from "vitest"
import { apiCall } from "./api"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("apiCall", () => {
  it("returns the JSON body and logs nothing", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{"ok":true}', { headers: { "Content-Type": "application/json" } }),
    )
    vi.stubGlobal("fetch", fetchMock)
    const log = vi.spyOn(console, "log")

    expect(await apiCall("/settings")).toEqual({ ok: true })
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/settings$/)
    // It runs on every SSR request: a line per call (with query strings) flooded the
    // production logs (#316).
    expect(log).not.toHaveBeenCalled()
  })

  it("throws the API's error message with the status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"request_id":"r-1","error":"post not found"}', { status: 404 })))

    const error = await apiCall("/posts/9").catch((e) => e)
    expect(error.message).toBe("post not found")
    expect(error.status).toBe(404)
  })

  it("keeps a non-JSON error body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Bad Gateway", { status: 502 })))

    const error = await apiCall("/settings").catch((e) => e)
    expect(error.message).toBe("HTTP 502: Bad Gateway")
    expect(error.status).toBe(502)
  })
})
