import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("./siteSettings", () => ({
  getSiteSettings: async () => ({ title: "Field Notes", postsPerPage: 2, urlStructure: "slug" }),
}))
vi.mock("./api", () => ({ getFeaturedImageUrl: async () => null }))

const { authorPath, getPostAuthors, getPublicAuthors, loadAuthorPage } = await import("./authorPage")
const { SERVER_MEDIA_URL } = await import("@gl-admin/lib/server-api-url")

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const author = { username: "ana", full_name: "Ana Costa", avatar: null, bio: "Edits.", website: "https://ana.example" }
const row = (id: number) => ({
  id,
  title: `Post ${id}`,
  slug: `post-${id}`,
  post_type: "post",
  post_status: "published",
  meta: { _thumbnail_url: "" },
  authors: [{ id: 9, username: "ana", full_name: "Ana Costa" }],
})

afterEach(() => vi.unstubAllGlobals())

describe("authorPath", () => {
  it("encodes the username", () => {
    expect(authorPath("ana")).toBe("/author/ana")
    expect(authorPath("a/b c")).toBe("/author/a%2Fb%20c")
  })
})

describe("loadAuthorPage", () => {
  it("loads the profile and one page of posts at their slug URLs", async () => {
    // One call: the posts route carries the author and the total.
    const fetchMock = vi.fn(async () => json(200, { author, posts: [row(3), row(4)], meta: { total: 5 } }))
    vi.stubGlobal("fetch", fetchMock)
    const data = await loadAuthorPage("ana", 2, "https://example.org")
    expect(data?.author).toEqual(author)
    expect(data?.postCount).toBe(5)
    expect(data?.list.posts.map((p) => p.href)).toEqual(["/post/post-3", "/post/post-4"])
    expect(data?.list).toMatchObject({ page: 2, totalPages: 3, basePath: "/author/ana" })
    expect(data?.list.links).toEqual({ newer: "/author/ana", older: "/author/ana/page/3/" })
    expect(data?.list.siteTitle).toBe("Field Notes")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe(`${SERVER_MEDIA_URL}/public/authors/ana/posts?limit=2&offset=2`)
    expect(((fetchMock.mock.calls[0] as unknown[])[1] as RequestInit).signal).toBeInstanceOf(AbortSignal)
  })

  it("is null for a page past the end, so the route 404s", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { author, posts: [], meta: { total: 5 } })))
    await expect(loadAuthorPage("ana", 4, "https://example.org")).resolves.toBeNull()
  })

  it("is null when the API has no page for the username (unknown or uncredited alike)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(404, { error: "author not found" })))
    await expect(loadAuthorPage("nobody", 1, "https://example.org")).resolves.toBeNull()
  })

  it("throws on other failures, so the page is a 500 rather than a false 404", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(500, { error: "boom" })))
    await expect(loadAuthorPage("ana", 1, "https://example.org")).rejects.toThrow(/500/)
  })
})

describe("getPostAuthors", () => {
  it("returns the cards, [] for a post without any", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { authors: [author] })))
    await expect(getPostAuthors(7)).resolves.toEqual([author])
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { authors: [] })))
    await expect(getPostAuthors(7)).resolves.toEqual([])
  })
})

describe("getPublicAuthors", () => {
  it("pages through every author", async () => {
    const all = Array.from({ length: 1500 }, (_, i) => ({ username: `a${i}`, last_modified: "2026-10-01T00:00:00Z" }))
    const fetchMock = vi.fn(async (url: string) => {
      const offset = Number(new URL(url).searchParams.get("offset"))
      return json(200, { authors: all.slice(offset, offset + 1000) })
    })
    vi.stubGlobal("fetch", fetchMock)
    await expect(getPublicAuthors()).resolves.toHaveLength(1500)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
