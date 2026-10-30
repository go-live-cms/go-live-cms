import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("./siteSettings", () => ({
  getSiteSettings: async () => ({ title: "Field Notes", postsPerPage: 2, urlStructure: "slug" }),
}))
const getTaxonomyTypes = vi.fn()
vi.mock("./api", () => ({
  getFeaturedImageUrl: async () => null,
  getTaxonomyTypes: () => getTaxonomyTypes(),
}))

const { getPublicTerms, isTermRoute, linkTerms, loadTermPage, publicTaxonomyNames, termKindLabel, termPath, termPhrase } = await import("./termPage")
const { resolveListRequest } = await import("./pagination")
const { SERVER_MEDIA_URL } = await import("@gl-admin/lib/server-api-url")

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const term = { id: 7, name: "Guides", slug: "guides", description: "How-tos.", taxonomy: "category", taxonomy_label: "Categories", hierarchical: true }
const row = (id: number) => ({
  id,
  title: `Post ${id}`,
  slug: `post-${id}`,
  post_type: "post",
  post_status: "published",
  meta: { _thumbnail_url: "" },
  authors: [],
})
const types = [
  { name: "category", label: "Categories", public: true },
  { name: "tag", label: "Tags", public: true },
  { name: "internal", label: "Internal", public: false },
]

afterEach(() => {
  vi.unstubAllGlobals()
  getTaxonomyTypes.mockReset()
})

describe("termPath", () => {
  it("is /{taxonomy}/{slug}, both encoded", () => {
    expect(termPath("category", "guides")).toBe("/category/guides")
    expect(termPath("tag", "c++ tips")).toBe("/tag/c%2B%2B%20tips")
  })
})

describe("route resolution", () => {
  const names = async () => publicTaxonomyNames(types)

  it("is a term route for a public taxonomy no public post type shares", async () => {
    await expect(isTermRoute("category", ["post", "page"], names)).resolves.toBe(true)
    await expect(isTermRoute("tag", ["post", "page"], names)).resolves.toBe(true)
  })

  it("leaves post types, unknown names and non-public taxonomies to the post route", async () => {
    // A post type keeps its URLs even when a taxonomy has the same name.
    await expect(isTermRoute("category", ["post", "category"], names)).resolves.toBe(false)
    await expect(isTermRoute("post", ["post", "page"], names)).resolves.toBe(false)
    await expect(isTermRoute("author-ish", ["post"], names)).resolves.toBe(false)
    await expect(isTermRoute("internal", ["post"], names)).resolves.toBe(false)
  })

  it("asks the taxonomies only when the name isn't a public post type", async () => {
    const lookup = vi.fn(names)
    await isTermRoute("post", ["post"], lookup)
    expect(lookup).not.toHaveBeenCalled()
    // Without the post type list the taxonomy still decides.
    await expect(isTermRoute("tag", null, lookup)).resolves.toBe(true)
  })

  it("is not a term route when the taxonomy lookup fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await expect(isTermRoute("category", ["post"], async () => Promise.reject(new Error("down")))).resolves.toBe(false)
    warn.mockRestore()
  })

  it("uses the API's taxonomy list by default", async () => {
    getTaxonomyTypes.mockResolvedValue(types)
    await expect(isTermRoute("tag", ["post"])).resolves.toBe(true)
  })

  it("keeps the taxonomy list for a minute and retries after a failure", async () => {
    const { getCachedTaxonomyTypes } = await import("./termPage")
    // Past anything an earlier test cached at the real clock.
    const t0 = Date.now() + 3_600_000
    getTaxonomyTypes.mockRejectedValueOnce(new Error("down")).mockResolvedValue(types)
    await expect(getCachedTaxonomyTypes(t0)).rejects.toThrow("down")
    // The failure isn't kept.
    await expect(getCachedTaxonomyTypes(t0 + 1)).resolves.toEqual(types)
    await getCachedTaxonomyTypes(t0 + 59_000)
    expect(getTaxonomyTypes).toHaveBeenCalledTimes(2)
    await getCachedTaxonomyTypes(t0 + 61_001)
    expect(getTaxonomyTypes).toHaveBeenCalledTimes(3)
  })

  it("pages a term like the other lists: /category/guides/page/2/", () => {
    const base = termPath("category", "guides")
    expect(resolveListRequest(new URL("https://x/category/guides/page/2/"), base, "2")).toEqual({ kind: "page", page: 2 })
    expect(resolveListRequest(new URL("https://x/category/guides?page=3"), base)).toEqual({ kind: "redirect", location: "/category/guides/page/3/" })
    expect(resolveListRequest(new URL("https://x/category/guides/page/1/"), base, "1")).toEqual({ kind: "redirect", location: "/category/guides" })
    expect(resolveListRequest(new URL("https://x/category/guides/page/x/"), base, "x")).toEqual({ kind: "notFound" })
  })
})

describe("linkTerms", () => {
  it("links terms of public taxonomies and labels every known one, in order", () => {
    const terms = [
      { id: 1, name: "Guides", slug: "guides", taxonomy_type_name: "category" },
      { id: 2, name: "Editor", slug: "editor", taxonomy_type_name: "tag" },
      { id: 3, name: "Secret", slug: "secret", taxonomy_type_name: "internal" },
      { id: 4, name: "Orphan", slug: "orphan", taxonomy_type_name: "gone" },
    ] as never[]
    expect(linkTerms(terms, types)).toEqual([
      { id: 1, name: "Guides", slug: "guides", taxonomy_type_name: "category", taxonomy_label: "Categories", href: "/category/guides" },
      { id: 2, name: "Editor", slug: "editor", taxonomy_type_name: "tag", taxonomy_label: "Tags", href: "/tag/editor" },
      { id: 3, name: "Secret", slug: "secret", taxonomy_type_name: "internal", taxonomy_label: "Internal" },
      { id: 4, name: "Orphan", slug: "orphan", taxonomy_type_name: "gone" },
    ])
  })

  it("leaves every term unlinked without the taxonomy list", () => {
    const terms = [{ id: 1, name: "Guides", slug: "guides", taxonomy_type_name: "category" }] as never[]
    expect(linkTerms(terms, [])[0]).not.toHaveProperty("href")
  })
})

describe("loadTermPage", () => {
  it("loads the term and one page of its posts at their slug URLs", async () => {
    const fetchMock = vi.fn(async () => json(200, { term, posts: [row(3), row(4)], pagination: { page: 2, per_page: 2, total: 5, total_pages: 3 } }))
    vi.stubGlobal("fetch", fetchMock)
    const data = await loadTermPage("category", "guides", 2, "https://example.org")
    expect(data?.term).toEqual(term)
    expect(data?.postCount).toBe(5)
    expect(data?.list.posts.map((p) => p.href)).toEqual(["/post/post-3", "/post/post-4"])
    expect(data?.list).toMatchObject({ page: 2, totalPages: 3, total: 5, basePath: "/category/guides", siteTitle: "Field Notes" })
    expect(data?.list.links).toEqual({ newer: "/category/guides", older: "/category/guides/page/3/" })
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe(`${SERVER_MEDIA_URL}/public/taxonomies/category/terms/guides/posts?page=2`)
  })

  it("asks for page 1 without a query and encodes the path", async () => {
    const fetchMock = vi.fn(async () => json(200, { term: { ...term, slug: "a b" }, posts: [], pagination: { page: 1, per_page: 2, total: 0, total_pages: 0 } }))
    vi.stubGlobal("fetch", fetchMock)
    const data = await loadTermPage("category", "a b", 1, "https://example.org")
    expect(data?.list.posts).toEqual([])
    expect(data?.list.basePath).toBe("/category/a%20b")
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe(`${SERVER_MEDIA_URL}/public/taxonomies/category/terms/a%20b/posts`)
  })

  it("is null when the API has no page (unknown term, non-public taxonomy, past the end)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(404, { error: "term not found" })))
    await expect(loadTermPage("category", "nothing", 1, "https://example.org")).resolves.toBeNull()
  })

  it("throws on other failures, so the route answers 500", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(500, { error: "boom" })))
    await expect(loadTermPage("category", "guides", 1, "https://example.org")).rejects.toThrow("HTTP 500")
  })
})

describe("getPublicTerms", () => {
  it("pages through the sitemap list 1000 at a time", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ taxonomy: "tag", slug: `t${i}`, last_modified: "2026-10-01T00:00:00Z" }))
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, { terms: full }))
      .mockResolvedValueOnce(json(200, { terms: [{ taxonomy: "category", slug: "guides", last_modified: "2026-10-02T00:00:00Z" }] }))
    vi.stubGlobal("fetch", fetchMock)
    const terms = await getPublicTerms()
    expect(terms).toHaveLength(1001)
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      `${SERVER_MEDIA_URL}/public/terms?limit=1000&offset=0`,
      `${SERVER_MEDIA_URL}/public/terms?limit=1000&offset=1000`,
    ])
  })
})

describe("wording", () => {
  it("names the built-in taxonomies in the singular, others by their label", () => {
    expect(termKindLabel({ taxonomy: "category", taxonomy_label: "Categories" })).toBe("Category")
    expect(termKindLabel({ taxonomy: "tag", taxonomy_label: "Tags" })).toBe("Tag")
    expect(termKindLabel({ taxonomy: "page_category", taxonomy_label: "Page Categories" })).toBe("Page category")
    expect(termKindLabel({ taxonomy: "series", taxonomy_label: "Series" })).toBe("Series")
    expect(termKindLabel({ taxonomy: "topic", taxonomy_label: "" })).toBe("topic")
  })

  it("says 'in' for a category and 'tagged' for a tag", () => {
    expect(termPhrase({ name: "Guides", hierarchical: true })).toBe("in Guides")
    expect(termPhrase({ name: "Editor", hierarchical: false })).toBe("tagged Editor")
  })
})
