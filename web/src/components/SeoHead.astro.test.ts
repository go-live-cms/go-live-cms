// Renders SeoHead.astro and a theme post layout with Astro's Container API and
// checks the <head> a crawler would see (#137).
import { experimental_AstroContainer as AstroContainer } from "astro/container"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
// The theme's menus (#347) aren't what these tests check: no API call for them.
vi.mock("@/lib/menus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/menus")>()),
  getMenu: async () => null,
}))
// The site settings (#330): no API call; a test may set a tagline.
const getSiteSettings = vi.fn()
vi.mock("@/lib/siteSettings", () => ({ getSiteSettings: (...args: unknown[]) => getSiteSettings(...args) }))
const SITE = { title: "My Site", tagline: "", postsPerPage: 10, urlStructure: "slug", language: "en-US", timeZone: "UTC", dateFormat: "month_day_year" }
import SeoHead from "./SeoHead.astro"
import DefaultPostLayout from "../../themes/default/layouts/post/default.astro"
import DefaultErrorLayout from "../../themes/default/layouts/error/default.astro"

const post = {
  id: 42,
  title: "Hello World",
  description: "<p>An excerpt</p>",
  user_id: 1,
  username: "admin",
  url: "",
  slug: "hello-world",
  post_type: "post",
  post_status: "published",
  menu_order: 0,
  created_at: "2026-10-01T10:00:00Z",
  changed_at: "2026-10-02T12:30:00Z",
}

const seo = {
  canonical: "/post/hello-world",
  image: "http://localhost:8080/uploads/media/cover.jpg",
  type: "article" as const,
  siteName: "My Site",
  publishedTime: post.created_at,
  modifiedTime: post.changed_at,
}

function head(html: string): string {
  const match = html.match(/<head>([\s\S]*?)<\/head>/)
  return match ? match[1] : html
}

let previousSiteUrl: string | undefined

beforeEach(() => {
  previousSiteUrl = process.env.SITE_URL
  getSiteSettings.mockReset().mockResolvedValue(SITE)
  process.env.SITE_URL = "https://example.org"
})

afterEach(() => {
  if (previousSiteUrl === undefined) delete process.env.SITE_URL
  else process.env.SITE_URL = previousSiteUrl
})

describe("SeoHead", () => {
  it("emits canonical, Open Graph and Twitter tags on the configured site URL", async () => {
    const container = await AstroContainer.create()
    const html = await container.renderToString(SeoHead, {
      props: { title: "Hello World | Post", description: "An excerpt", ...seo },
      request: new Request("http://web:4321/post/42?utm_source=x"),
    })

    expect(html).toContain("<title>Hello World | Post</title>")
    expect(html).toContain('<meta name="description" content="An excerpt">')
    expect(html).toContain('<link rel="canonical" href="https://example.org/post/hello-world">')
    expect(html).toContain('<meta property="og:type" content="article">')
    expect(html).toContain('<meta property="og:site_name" content="My Site">')
    expect(html).toContain('<meta property="og:url" content="https://example.org/post/hello-world">')
    expect(html).toContain('<meta property="og:image" content="https://example.org/uploads/media/cover.jpg">')
    expect(html).toContain('<meta property="article:modified_time" content="2026-10-02T12:30:00Z">')
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">')
    expect(html).toContain('<meta name="twitter:image" content="https://example.org/uploads/media/cover.jpg">')
    expect(html).not.toContain("noindex")
  })

  it("defaults the canonical to the request path without the query string", async () => {
    const container = await AstroContainer.create()
    const html = await container.renderToString(SeoHead, {
      props: { title: "Posts" },
      request: new Request("http://web:4321/post?page=2"),
    })
    expect(html).toContain('<link rel="canonical" href="https://example.org/post">')
    expect(html).toContain('<meta name="twitter:card" content="summary">')
    expect(html).not.toContain("og:image")
  })

  it("renders noindex and no canonical for non-public pages", async () => {
    const container = await AstroContainer.create()
    const html = await container.renderToString(SeoHead, {
      props: { title: "Sign in", noindex: true },
      request: new Request("http://web:4321/login"),
    })
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">')
    expect(html).not.toContain('rel="canonical"')
  })

  it("takes the site name from the settings and falls back to the tagline for the description (#330)", async () => {
    getSiteSettings.mockResolvedValue({ ...SITE, title: "Field Notes", tagline: "Notes from the team" })
    const container = await AstroContainer.create()
    const html = await container.renderToString(SeoHead, {
      props: { title: "Field Notes" },
      request: new Request("http://web:4321/"),
    })
    expect(html).toContain('<meta property="og:site_name" content="Field Notes">')
    expect(html).toContain('<meta name="description" content="Notes from the team">')
    expect(html).toContain('<meta name="twitter:description" content="Notes from the team">')

    // Neither: no description tags at all.
    getSiteSettings.mockResolvedValue(SITE)
    const bare = await container.renderToString(SeoHead, { props: { title: "x" }, request: new Request("http://web:4321/") })
    expect(bare).not.toContain('name="description"')
  })
})

describe("theme layouts", () => {
  it("the default post layout puts the SEO tags in <head>", async () => {
    const container = await AstroContainer.create()
    const html = await container.renderToString(DefaultPostLayout, {
      props: { post, title: "Hello World | Post", description: "An excerpt", seo },
      request: new Request("http://web:4321/post/42"),
    })
    const headHtml = head(html)

    expect(headHtml.match(/<title>/g)).toHaveLength(1)
    expect(headHtml.match(/name="description"/g)).toHaveLength(1)
    expect(headHtml).toContain('<link rel="canonical" href="https://example.org/post/hello-world">')
    expect(headHtml).toContain('<meta property="og:title" content="Hello World | Post">')
    expect(headHtml).toContain('<meta property="og:image" content="https://example.org/uploads/media/cover.jpg">')
  })

  it("the default error layout is noindex", async () => {
    const container = await AstroContainer.create()
    const html = await container.renderToString(DefaultErrorLayout, {
      props: { status: 404, title: "Page not found", message: "Gone." },
      request: new Request("http://web:4321/nope"),
    })
    expect(head(html)).toContain('<meta name="robots" content="noindex, nofollow">')
    expect(head(html)).not.toContain('rel="canonical"')
  })
})
