import { afterEach, describe, expect, it, vi } from "vitest"
import { apiCall } from "./api"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("apiCall", () => {
  it("returns the JSON body and logs nothing", async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { headers: { "Content-Type": "application/json" } }))
    vi.stubGlobal("fetch", fetchMock)
    const log = vi.spyOn(console, "log")

    expect(await apiCall("/settings")).toEqual({ ok: true })
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/settings$/)
    // It runs on every SSR request: a line per call (with query strings) flooded the
    // production logs (#316).
    expect(log).not.toHaveBeenCalled()
  })

  it("throws the API's error message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"nope"}', { status: 403 })))

    await expect(apiCall("/users")).rejects.toThrow("nope")
  })
})
