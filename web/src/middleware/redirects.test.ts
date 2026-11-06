import { describe, expect, it, vi } from "vitest"
import { redirectLocation, redirectOn404, type RedirectTarget } from "./redirects"
import { log } from "../lib/log"

const notFound = () => new Response("Not found", { status: 404 })
const get = (path: string, method = "GET") => {
  const url = new URL(`http://site.test${path}`)
  return { request: new Request(url, { method }), url }
}

describe("redirectOn404 (#331)", () => {
  it("answers a 404 with the redirect for its address", async () => {
    const lookup = vi.fn(async (): Promise<RedirectTarget> => ({ to_path: "/tag/images", status_code: 301 }))
    const { request, url } = get("/tag/photos")
    const response = await redirectOn404(request, url, notFound(), lookup)
    expect(lookup).toHaveBeenCalledWith("/tag/photos")
    expect(response.status).toBe(301)
    expect(response.headers.get("Location")).toBe("/tag/images")
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600")
  })

  it("keeps the query and escapes the target; a 302 isn't cached", async () => {
    const { request, url } = get("/old?utm=x")
    const response = await redirectOn404(request, url, notFound(), async () => ({ to_path: "/tag/são", status_code: 302 }))
    expect(response.status).toBe(302)
    expect(response.headers.get("Location")).toBe("/tag/s%C3%A3o?utm=x")
    expect(response.headers.get("Cache-Control")).toBe("no-cache")
  })

  it("sends external targets as they are", () => {
    expect(redirectLocation("https://golive.dev/launch", new URL("http://site.test/launch?x=1"))).toBe("https://golive.dev/launch")
  })

  it("never asks for a page that exists, a non-GET or the admin's paths", async () => {
    const lookup = vi.fn(async () => ({ to_path: "/x", status_code: 301 }))
    const ok = new Response("ok", { status: 200 })
    expect(await redirectOn404(get("/live").request, get("/live").url, ok, lookup)).toBe(ok)
    for (const [path, method] of [["/old", "POST"], ["/gl-admin/settings", "GET"], ["/gl-admin", "GET"], ["/uploads/a.jpg", "GET"], ["/api/v1/x", "GET"]]) {
      const { request, url } = get(path, method)
      const response = notFound()
      expect(await redirectOn404(request, url, response, lookup)).toBe(response)
    }
    expect(lookup).not.toHaveBeenCalled()
  })

  it("keeps the 404 when nothing redirects or the lookup fails", async () => {
    const { request, url } = get("/gone")
    const first = notFound()
    expect(await redirectOn404(request, url, first, async () => null)).toBe(first)
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {})
    const second = notFound()
    expect(await redirectOn404(request, url, second, async () => Promise.reject(new Error("down")))).toBe(second)
    expect(warn).toHaveBeenCalledWith("redirect_lookup_failed", expect.anything())
    warn.mockRestore()
  })
})

describe("lookupRedirect", () => {
  it("keeps answers for a minute, found or not, but not failures", async () => {
    const { lookupRedirect, clearRedirectCache } = await import("./redirects")
    clearRedirectCache()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "no redirect" }), { status: 404 }))
    vi.stubGlobal("fetch", fetchMock)
    expect(await lookupRedirect("/probe", 0)).toBeNull()
    expect(await lookupRedirect("/probe", 1000)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await lookupRedirect("/probe", 61_000)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)

    fetchMock.mockImplementationOnce(async () => new Response("down", { status: 500 }))
    await expect(lookupRedirect("/flaky", 0)).rejects.toThrow()
    await Promise.resolve()
    expect(await lookupRedirect("/flaky", 0)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(4)
    vi.unstubAllGlobals()
    clearRedirectCache()
  })
})
