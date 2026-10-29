import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Post } from "@gl-admin/lib/api/types"
import { listedThumbnail, listSeo, loadPostList } from "./postList"
import { postLayoutCandidates, themeLayoutCandidates } from "./themeLayout"

const getPublicPostsPage = vi.fn()
vi.mock("./api", () => ({
  getPublicPostsPage: (...args: unknown[]) => getPublicPostsPage(...args),
  getFeaturedImageUrl: async () => null,
}))
vi.mock("./siteSettings", () => ({
  getSiteSettings: async () => ({ title: "Field Notes", postsPerPage: 2, urlStructure: "slug" }),
}))

describe("themeLayoutCandidates", () => {
  it("tries the theme's variant, its default, then the default theme's", () => {
    expect(themeLayoutCandidates("../../themes", "magazine", "home")).toEqual([
      "../../themes/magazine/layouts/home/default.astro",
      "../../themes/default/layouts/home/default.astro",
    ])
    expect(themeLayoutCandidates("../themes", "default", "post", "wide")).toEqual([
      "../themes/default/layouts/post/wide.astro",
      "../themes/default/layouts/post/default.astro",
    ])
  })
})

describe("postLayoutCandidates", () => {
  it("tries the type's own folder first, then the theme's and the default theme's post layouts", () => {
    expect(postLayoutCandidates("..", "magazine", "page", "fullwidth")).toEqual([
      "../magazine/layouts/page/fullwidth.astro",
      "../magazine/layouts/post/fullwidth.astro",
      "../magazine/layouts/post/default.astro",
      "../default/layouts/page/fullwidth.astro",
      "../default/layouts/post/fullwidth.astro",
      "../default/layouts/post/default.astro",
    ])
  })

  it("never treats the home, archive or error page layouts as a post type's", () => {
    for (const type of ["home", "archive", "error"]) {
      const candidates = postLayoutCandidates("..", "default", type, "default")
      expect(candidates.every((c) => c.includes("/layouts/post/"))).toBe(true)
    }
  })
})

describe("listedThumbnail", () => {
  const row = (meta?: Record<string, unknown>) => ({ id: 1, ...(meta ? { meta } : {}) }) as unknown as Post

  it("uses the URL a with_meta row carries, null when there is none", () => {
    expect(listedThumbnail(row({ _thumbnail_url: "/uploads/media/a.jpg" }))).toBe("/uploads/media/a.jpg")
    expect(listedThumbnail(row({ _thumbnail_url: "http://localhost:8080/uploads/a.jpg" }))).toBe("http://localhost:8080/uploads/a.jpg")
    expect(listedThumbnail(row({}))).toBeNull()
    expect(listedThumbnail(row())).toBeNull()
  })

  it("leaves an old filesystem path to the featured-image endpoint", () => {
    expect(listedThumbnail(row({ _thumbnail_url: "./uploads/media/a.jpg" }))).toBeUndefined()
    expect(listedThumbnail(row({ _thumbnail_url: "/app/uploads/media/a.jpg" }))).toBeUndefined()
  })
})

describe("loadPostList", () => {
  const row = (id: number) => ({ id, slug: `p${id}`, post_type: "post", title: `Post ${id}` }) as unknown as Post
  beforeEach(() => getPublicPostsPage.mockReset())

  it("takes the page and its totals from the API, with clean newer/older links", async () => {
    getPublicPostsPage.mockResolvedValue({ posts: [row(3), row(4)], pagination: { page: 2, per_page: 2, total: 5, total_pages: 3 } })
    const list = await loadPostList("post", 2, "/post", "https://example.org")
    expect(getPublicPostsPage).toHaveBeenCalledWith("post", 2)
    expect(list).toMatchObject({ page: 2, total: 5, totalPages: 3, basePath: "/post", siteTitle: "Field Notes" })
    expect(list?.posts.map((p) => p.href)).toEqual(["/post/p3", "/post/p4"])
    expect(list?.links).toEqual({ newer: "/post", older: "/post/page/3/" })
  })

  it("is null for a page past the end (the API 404s it), so the route 404s", async () => {
    getPublicPostsPage.mockResolvedValue(null)
    expect(await loadPostList("post", 4, "/", "https://example.org")).toBeNull()
  })

  it("still has a first page when the API lists nothing", async () => {
    getPublicPostsPage.mockResolvedValue(null)
    expect(await loadPostList("post", 1, "/", "https://example.org")).toMatchObject({ posts: [], total: 0, totalPages: 0, links: {} })
  })
})

describe("listSeo", () => {
  it("canonicalizes each page and links its neighbours", () => {
    expect(listSeo({ page: 1, basePath: "/", links: { older: "/page/2/" } })).toEqual({ canonical: "/", prev: undefined, next: "/page/2/" })
    expect(listSeo({ page: 2, basePath: "/post", links: { newer: "/post", older: "/post/page/3/" } })).toEqual({
      canonical: "/post/page/2/",
      prev: "/post",
      next: "/post/page/3/",
    })
  })
})
