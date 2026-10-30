import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("./siteSettings", () => ({
  getSiteSettings: async () => ({ title: "Field Notes", postsPerPage: 10, urlStructure: "slug" }),
}))
const getPostsByType = vi.fn()
vi.mock("./api", () => ({ getPostsByType: (...args: unknown[]) => getPostsByType(...args) }))

const {
  highlightText,
  loadSearchPage,
  normalizeQuery,
  parseSearchType,
  resultCountLabel,
  resultLabels,
  safeHighlight,
  searchChips,
  searchUrl,
  MAX_QUERY_LENGTH,
} = await import("./search")
const { SERVER_API_URL, SERVER_MEDIA_URL } = await import("@gl-admin/lib/server-api-url")

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

afterEach(() => {
  vi.unstubAllGlobals()
  getPostsByType.mockReset()
})

describe("safeHighlight", () => {
  it("keeps the API's escaped text and <mark>", () => {
    expect(safeHighlight("Writing <mark>alt</mark> &amp; &#39;text&#39;")).toBe("Writing <mark>alt</mark> &amp; &#39;text&#39;")
  })

  it("escapes any other markup, whatever reaches it", () => {
    // A <mark> with attributes isn't the API's: text, and its stray </mark> dropped.
    expect(safeHighlight('<script>alert(1)</script><mark onclick="x">a</mark>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;&lt;mark onclick="x"&gt;a'
    )
    expect(safeHighlight("<img src=x onerror=alert(1)>")).toBe("&lt;img src=x onerror=alert(1)&gt;")
    expect(safeHighlight("<MARK>a</MARK>")).toBe("&lt;MARK&gt;a&lt;/MARK&gt;")
  })

  it("escapes a bare & but keeps entities", () => {
    expect(safeHighlight("a & b &lt; &#x3C; &#60; &nbsp;")).toBe("a &amp; b &lt; &#x3C; &#60; &nbsp;")
  })

  it("balances marks", () => {
    expect(safeHighlight("<mark>a")).toBe("<mark>a</mark>")
    expect(safeHighlight("a</mark> b")).toBe("a b")
    expect(safeHighlight("<mark><mark>a</mark>")).toBe("<mark>a</mark>")
  })

  it("is empty for nothing", () => {
    expect(safeHighlight(undefined)).toBe("")
    expect(safeHighlight("")).toBe("")
    expect(highlightText("a <mark>b</mark>")).toBe("a b")
  })
})

describe("query and URLs", () => {
  it("normalizes the query", () => {
    expect(normalizeQuery("  alt \n text ")).toBe("alt text")
    expect(normalizeQuery(null)).toBe("")
    expect(Array.from(normalizeQuery("😀".repeat(MAX_QUERY_LENGTH + 5)))).toHaveLength(MAX_QUERY_LENGTH)
  })

  it("parses the type", () => {
    expect(parseSearchType(null)).toBe("all")
    expect(parseSearchType("all")).toBe("all")
    expect(parseSearchType("page")).toBe("page")
    expect(parseSearchType("media")).toBeNull()
  })

  it("builds clean URLs that keep the query", () => {
    expect(searchUrl("alt text")).toBe("/search?q=alt+text")
    expect(searchUrl("alt text", "post")).toBe("/search?q=alt+text&type=post")
    expect(searchUrl("alt", "page", 3)).toBe("/search/page/3/?q=alt&type=page")
    expect(searchUrl("<script>&")).toBe("/search?q=%3Cscript%3E%26")
    expect(searchUrl("")).toBe("/search")
  })

  it("makes the All / Posts / Pages chips", () => {
    expect(searchChips("alt", "post", { all: 4, post: 3, page: 1 })).toEqual([
      { type: "all", label: "All", count: 4, href: "/search?q=alt", current: false },
      { type: "post", label: "Posts", count: 3, href: "/search?q=alt&type=post", current: true },
      { type: "page", label: "Pages", count: 1, href: "/search?q=alt&type=page", current: false },
    ])
  })

  it("labels results", () => {
    expect(resultLabels({ post_type: "post", created_at: "2026-10-15T10:00:00Z", changed_at: "2026-10-20T10:00:00Z" })).toEqual({ typeLabel: "Post", dateLabel: "Oct 15, 2026" })
    expect(resultLabels({ post_type: "page", created_at: "2026-01-01T00:00:00Z", changed_at: "2026-09-30T00:00:00Z" })).toEqual({ typeLabel: "Page", dateLabel: "Updated Sep 30, 2026" })
    // A page never edited keeps the 0001 sentinel: its creation date then.
    expect(resultLabels({ post_type: "page", created_at: "2026-01-02T00:00:00Z", changed_at: "0001-01-01T00:00:00Z" }).dateLabel).toBe("Updated Jan 2, 2026")
    expect(resultCountLabel(1)).toBe("1 result")
    expect(resultCountLabel(4)).toBe("4 results")
  })
})

describe("loadSearchPage", () => {
  const hit = (id: number, extra: Record<string, unknown> = {}) => ({
    id,
    title: `Post ${id}`,
    slug: `post-${id}`,
    post_type: "post",
    created_at: "2026-10-15T10:00:00Z",
    changed_at: "2026-10-15T10:00:00Z",
    title_html: `<mark>Post</mark> ${id}`,
    excerpt_html: "an <mark>excerpt</mark>",
    ...extra,
  })

  it("loads one page of results at their slug URLs, with the chips", async () => {
    const fetchMock = vi.fn(async () =>
      json(200, {
        query: "post",
        type: "post",
        results: [hit(1), hit(2, { post_type: "page", slug: "about", title_html: "<script>x</script>" })],
        counts: { all: 13, post: 12, page: 1 },
        pagination: { page: 2, per_page: 10, total: 12, total_pages: 2 },
      })
    )
    vi.stubGlobal("fetch", fetchMock)
    const data = await loadSearchPage("post", "post", 2)
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe(`${SERVER_MEDIA_URL}/public/search?q=post&type=post&page=2`)
    expect(data?.results.map((r) => r.href)).toEqual(["/post/post-1", "/page/about"])
    expect(data?.results[0].titleHtml).toBe("<mark>Post</mark> 1")
    expect(data?.results[1].titleHtml).toBe("&lt;script&gt;x&lt;/script&gt;")
    expect(data).toMatchObject({ total: 12, page: 2, totalPages: 2, pageQuery: "?q=post&type=post", siteTitle: "Field Notes", topics: [], recent: [] })
    expect(data?.chips.find((c) => c.current)?.type).toBe("post")
    expect(getPostsByType).not.toHaveBeenCalled()
  })

  it("fills the empty state's topics and recent posts when nothing matched", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith(`${SERVER_API_URL}/taxonomy/terms/popular`)
        ? json(200, { taxonomy_terms: [{ name: "Guides", slug: "guides" }, { name: " ", slug: "x" }] })
        : json(200, { query: "zzz", type: "all", results: [], counts: { all: 0, post: 0, page: 0 }, pagination: { page: 1, per_page: 10, total: 0, total_pages: 0 } })
    )
    vi.stubGlobal("fetch", fetchMock)
    getPostsByType.mockResolvedValue({ data: [{ id: 5, title: "Recent", slug: "recent", post_type: "post" }] })
    const data = await loadSearchPage("zzz", "all", 1)
    expect(data?.results).toEqual([])
    expect(data?.topics).toEqual([{ label: "Guides", href: "/category/guides" }])
    expect(data?.recent).toEqual([{ label: "Recent", href: "/post/recent" }])
  })

  it("an empty query asks the API nothing", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const data = await loadSearchPage("", "all", 1)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(data).toMatchObject({ query: "", total: 0, results: [] })
    expect(await loadSearchPage("", "all", 2)).toBeNull()
  })

  it("is null past the end, and throws on an API error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(404, { error: "page out of range" })))
    expect(await loadSearchPage("alt", "all", 9)).toBeNull()
    vi.stubGlobal("fetch", vi.fn(async () => json(500, { error: "x" })))
    await expect(loadSearchPage("alt", "all", 1)).rejects.toThrow("HTTP 500")
  })
})
