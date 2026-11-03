import { afterEach, describe, expect, it, vi } from "vitest"
import { apiCall, getPublicPost, getPublishedPosts } from "./api"
import { SERVER_MEDIA_URL } from "../../gl-admin/lib/server-api-url"

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

// The public site's reads of published posts (#358).
describe("getPublicPost", () => {
  const view = { post: { id: 7, title: "Published title" }, featured_image: { id: 5, url: "/uploads/media/p.jpg" }, taxonomy_terms: [{ id: 3 }] }

  it("reads /public/posts/:id for an id and /public/posts/slug/:slug for a slug", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify(view), { headers: { "Content-Type": "application/json" } }))
    vi.stubGlobal("fetch", fetchMock)

    expect(await getPublicPost(7)).toEqual(view)
    expect(await getPublicPost("a post/x")).toEqual(view)
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${SERVER_MEDIA_URL}/public/posts/7`)
    expect(String(fetchMock.mock.calls[1][0])).toBe(`${SERVER_MEDIA_URL}/public/posts/slug/a%20post%2Fx`)
  })

  it("is null on a 404 and throws other failures with the status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })))
    expect(await getPublicPost(7)).toBeNull()
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 502 })))
    const error = await getPublicPost(7).catch((e) => e)
    expect(error.status).toBe(502)
  })

  it("defaults a missing image and terms", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ post: { id: 7 } }))))
    expect(await getPublicPost(7)).toEqual({ post: { id: 7 }, featured_image: null, taxonomy_terms: [] })
  })
})

describe("getPublishedPosts", () => {
  it("reads the public list with the type, sort and paging", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ posts: [{ id: 1 }], meta: { total: 1 } })))
    vi.stubGlobal("fetch", fetchMock)

    const result = await getPublishedPosts("post", { sort: "date_desc", limit: 20, offset: 40 })
    expect(result.data).toEqual([{ id: 1 }])
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${SERVER_MEDIA_URL}/public/posts?type=post&limit=20&offset=40&sort=date_desc`)
  })

  it("throws with the status, e.g. a type that isn't public", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })))
    const error = await getPublishedPosts("secret").catch((e) => e)
    expect(error.status).toBe(404)
  })
})
