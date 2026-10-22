import { describe, expect, it } from "vitest"
import type { Post } from "@gl-admin/lib/api/types"
import {
  MAX_SITEMAP_URLS,
  buildRobotsTxt,
  buildSitemapXml,
  cacheControl,
  collectSitemapEntries,
  metaDescription,
  postPath,
  publicImageUrl,
  resolveSiteUrl,
  shouldNoindex,
  type SitemapSource,
} from "./seo"

function post(overrides: Partial<Post>): Post {
  return {
    id: 1,
    title: "Hello",
    description: "",
    user_id: 1,
    username: "admin",
    url: "",
    post_type: "post",
    post_status: "published",
    menu_order: 0,
    created_at: "2026-10-01T10:00:00Z",
    changed_at: "2026-10-02T12:30:00Z",
    ...overrides,
  }
}

describe("resolveSiteUrl", () => {
  it("prefers SITE_URL and drops the trailing slash", () => {
    expect(resolveSiteUrl("http://web:4321/post/1", { SITE_URL: "https://example.org/" })).toBe("https://example.org")
  })

  it("keeps a sub-path deployment", () => {
    expect(resolveSiteUrl("http://web:4321/", { SITE_URL: "https://example.org/blog/" })).toBe(
      "https://example.org/blog",
    )
  })

  it("falls back to the request origin when unset, empty or invalid", () => {
    expect(resolveSiteUrl("http://localhost:4321/post/1?x=1", {})).toBe("http://localhost:4321")
    expect(resolveSiteUrl("http://localhost:4321/", { SITE_URL: "  " })).toBe("http://localhost:4321")
    expect(resolveSiteUrl("http://localhost:4321/", { SITE_URL: "not a url" })).toBe("http://localhost:4321")
    expect(resolveSiteUrl("http://localhost:4321/", { SITE_URL: "ftp://example.org" })).toBe("http://localhost:4321")
  })
})

describe("cacheControl", () => {
  it("is public only when SITE_URL is set (no Host-header URLs in shared caches)", () => {
    expect(cacheControl(600, { SITE_URL: "https://example.org" })).toBe("public, max-age=600")
    expect(cacheControl(600, {})).toBe("private, no-store")
    expect(cacheControl(600, { SITE_URL: "not a url" })).toBe("private, no-store")
  })
})

describe("postPath", () => {
  it("uses the id unless the site uses slug URLs", () => {
    expect(postPath(post({ id: 7, slug: "hello-world" }), "id")).toBe("/post/7")
    expect(postPath(post({ id: 7, slug: "hello-world" }), "slug")).toBe("/post/hello-world")
  })

  it("falls back to the id for a post without a slug", () => {
    expect(postPath(post({ id: 7, slug: "" }), "slug")).toBe("/post/7")
  })

  it("uses the id for an all-digit slug, which the route would read as an id", () => {
    expect(postPath(post({ id: 7, slug: "2026" }), "slug")).toBe("/post/7")
    expect(postPath(post({ id: 7, slug: "post-2026" }), "slug")).toBe("/post/post-2026")
  })

  it("encodes the slug as one path segment", () => {
    expect(postPath(post({ slug: "são-paulo" , post_type: "page" }), "slug")).toBe("/page/s%C3%A3o-paulo")
  })
})

describe("publicImageUrl", () => {
  it("moves /uploads onto the public site, whatever host the admin stored", () => {
    expect(publicImageUrl("https://example.org", "http://localhost:8080/uploads/media/a.jpg")).toBe(
      "https://example.org/uploads/media/a.jpg",
    )
    expect(publicImageUrl("https://example.org", "/uploads/media/a.jpg")).toBe(
      "https://example.org/uploads/media/a.jpg",
    )
  })

  it("rewrites the SERVER_API_URL host too", () => {
    expect(
      publicImageUrl("https://example.org", "http://cms-api.internal:8080/uploads/media/a.jpg", {
        SERVER_API_URL: "http://cms-api.internal:8080/api/v1",
      }),
    ).toBe("https://example.org/uploads/media/a.jpg")
  })

  it("keeps other absolute URLs, even with an /uploads/ path, and rejects non-http ones", () => {
    expect(publicImageUrl("https://example.org", "https://cdn.example.net/a.jpg", {})).toBe(
      "https://cdn.example.net/a.jpg",
    )
    expect(publicImageUrl("https://example.org", "https://cdn.example.net/uploads/a.jpg", {})).toBe(
      "https://cdn.example.net/uploads/a.jpg",
    )
    expect(publicImageUrl("https://example.org", "javascript:alert(1)")).toBeUndefined()
    expect(publicImageUrl("https://example.org", null)).toBeUndefined()
  })
})

describe("metaDescription", () => {
  it("strips HTML and collapses whitespace", () => {
    expect(metaDescription("<p>Hello <strong>world</strong> &amp; friends</p>\n\n")).toBe("Hello world & friends")
  })

  it("decodes numeric entities", () => {
    expect(metaDescription("It&#8217;s here &#x2014; now &#39;quoted&#39;")).toBe("It’s here — now 'quoted'")
  })

  it("cuts long text at a word boundary", () => {
    const text = "word ".repeat(100)
    const result = metaDescription(text, 50)
    expect(result.length).toBeLessThanOrEqual(50)
    expect(result.endsWith("word…")).toBe(true)
  })

  it("returns an empty string for nothing", () => {
    expect(metaDescription(undefined)).toBe("")
  })
})

describe("shouldNoindex", () => {
  it("flags admin, login and error responses", () => {
    expect(shouldNoindex("/gl-admin", 200)).toBe(true)
    expect(shouldNoindex("/gl-admin/content/post", 200)).toBe(true)
    expect(shouldNoindex("/login", 200)).toBe(true)
    expect(shouldNoindex("/post/1", 404)).toBe(true)
    expect(shouldNoindex("/post/1", 500)).toBe(true)
  })

  it("leaves public pages indexable", () => {
    expect(shouldNoindex("/post/1", 200)).toBe(false)
    expect(shouldNoindex("/", 200)).toBe(false)
    // A post type whose name starts like an admin route is not the admin.
    expect(shouldNoindex("/gl-administration", 200)).toBe(false)
  })
})

describe("buildRobotsTxt", () => {
  it("disallows the admin and points at the sitemap on the site URL", () => {
    const robots = buildRobotsTxt("https://example.org")
    expect(robots).toContain("User-agent: *")
    expect(robots).toContain("Disallow: /gl-admin\n")
    expect(robots).toContain("Disallow: /login\n")
    expect(robots).toContain("Sitemap: https://example.org/sitemap.xml")
  })
})

describe("buildSitemapXml", () => {
  it("escapes locs and formats lastmod as W3C datetime", () => {
    const xml = buildSitemapXml([
      { loc: "https://example.org/post/a&b", lastmod: "2026-10-02T12:30:00Z" },
      { loc: "https://example.org/" },
    ])
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
    expect(xml).toContain("<loc>https://example.org/post/a&amp;b</loc>")
    expect(xml).toContain("<lastmod>2026-10-02T12:30:00.000Z</lastmod>")
    // No lastmod element for an entry without one.
    expect(xml).toMatch(/<loc>https:\/\/example\.org\/<\/loc>\n  <\/url>/)
  })
})

function source(postsByType: Record<string, Post[]>, structure: "id" | "slug" = "id"): SitemapSource & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    getPublicPostTypeNames: async () => Object.keys(postsByType),
    getUrlStructure: async () => structure,
    getPublishedPosts: async (type, limit, offset) => {
      calls.push(`${type}:${offset}`)
      return postsByType[type].slice(offset, offset + limit)
    },
  }
}

describe("collectSitemapEntries", () => {
  it("lists published posts with lastmod from changed_at, plus home and archives", async () => {
    const entries = await collectSitemapEntries(
      "https://example.org",
      source({
        post: [
          post({ id: 1, changed_at: "2026-10-02T12:30:00Z" }),
          post({ id: 2, changed_at: "2026-10-05T08:00:00Z" }),
        ],
        page: [post({ id: 3, post_type: "page" })],
      }),
    )
    expect(entries).toEqual([
      { loc: "https://example.org/" },
      { loc: "https://example.org/post", lastmod: "2026-10-05T08:00:00.000Z" },
      { loc: "https://example.org/post/1", lastmod: "2026-10-02T12:30:00.000Z" },
      { loc: "https://example.org/post/2", lastmod: "2026-10-05T08:00:00.000Z" },
      { loc: "https://example.org/page", lastmod: "2026-10-02T12:30:00.000Z" },
      { loc: "https://example.org/page/3", lastmod: "2026-10-02T12:30:00.000Z" },
    ])
  })

  it("skips drafts (incl. unpublished posts) and archived posts even if the API returns them", async () => {
    const entries = await collectSitemapEntries(
      "https://example.org",
      source({
        post: [
          post({ id: 1 }),
          post({ id: 2, post_status: "draft" }),
          post({ id: 3, post_status: "archived" }),
          post({ id: 4, post_type: "page" }),
        ],
      }),
    )
    expect(entries.map((e) => e.loc)).toEqual([
      "https://example.org/",
      "https://example.org/post",
      "https://example.org/post/1",
    ])
  })

  it("falls back to created_at when changed_at is Go's zero time", async () => {
    const entries = await collectSitemapEntries(
      "https://example.org",
      source({ post: [post({ id: 1, changed_at: "0001-01-01T00:00:00Z", created_at: "2026-10-22T17:13:01Z" })] }),
    )
    expect(entries[2]).toEqual({ loc: "https://example.org/post/1", lastmod: "2026-10-22T17:13:01.000Z" })
  })

  it("uses slug URLs when the site is set to slugs", async () => {
    const entries = await collectSitemapEntries(
      "https://example.org",
      source({ post: [post({ id: 1, slug: "hello-world" }), post({ id: 2, slug: "" })] }, "slug"),
    )
    expect(entries.map((e) => e.loc)).toContain("https://example.org/post/hello-world")
    expect(entries.map((e) => e.loc)).toContain("https://example.org/post/2")
  })

  it("omits the archive of a type with no published posts and never lists admin routes", async () => {
    const entries = await collectSitemapEntries("https://example.org", source({ post: [], page: [] }))
    expect(entries).toEqual([{ loc: "https://example.org/" }])
    expect(entries.some((e) => e.loc.includes("/gl-admin"))).toBe(false)
  })

  it("pages through the API 100 posts at a time", async () => {
    const many = Array.from({ length: 250 }, (_, i) => post({ id: i + 1 }))
    const src = source({ post: many })
    const entries = await collectSitemapEntries("https://example.org", src)
    expect(src.calls).toEqual(["post:0", "post:100", "post:200"])
    expect(entries).toHaveLength(252)
  })

  it("stops at the sitemap protocol's URL limit", async () => {
    const many = Array.from({ length: MAX_SITEMAP_URLS + 10 }, (_, i) => post({ id: i + 1 }))
    const entries = await collectSitemapEntries("https://example.org", source({ post: many }))
    expect(entries).toHaveLength(MAX_SITEMAP_URLS)
  })
})
