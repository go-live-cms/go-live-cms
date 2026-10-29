// Renders the default theme's header, footer and layouts with Astro's Container API
// (#345) and checks what readers get: the switch, the credit, the hidden parts.
import { experimental_AstroContainer as AstroContainer } from "astro/container"
import { getContainerRenderer as reactRenderer } from "@astrojs/react"
import { loadRenderers } from "astro:container"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/siteSettings", () => ({
  getSiteSettings: async () => ({ title: "Field Notes", postsPerPage: 10, urlStructure: "slug" }),
}))
const getPostsByType = vi.fn()
const getAdjacentPosts = vi.fn()
const getRelatedPosts = vi.fn()
vi.mock("@/lib/api", () => ({
  getTaxonomyTypes: async () => [{ name: "tag", label: "Tags" }],
  getPostsByType: (...args: unknown[]) => getPostsByType(...args),
  getAdjacentPosts: (...args: unknown[]) => getAdjacentPosts(...args),
  getRelatedPosts: (...args: unknown[]) => getRelatedPosts(...args),
  getFeaturedImageUrl: async () => null,
}))

const SiteHeader = (await import("./components/SiteHeader.astro")).default
const SiteFooter = (await import("./components/SiteFooter.astro")).default
const PostDefault = (await import("./layouts/post/default.astro")).default
const PostSidebar = (await import("./layouts/post/sidebar.astro")).default
const PostWide = (await import("./layouts/post/wide.astro")).default
const PageDefault = (await import("./layouts/page/default.astro")).default
const PageFull = (await import("./layouts/page/fullwidth.astro")).default
const Home = (await import("./layouts/home/default.astro")).default
const ErrorLayout = (await import("./layouts/error/default.astro")).default

const post = {
  id: 42,
  title: "Hello World",
  description: "<p>An <em>excerpt</em></p>",
  user_id: 3,
  username: "admin",
  url: "",
  slug: "hello-world",
  post_type: "post",
  post_status: "published",
  menu_order: 0,
  created_at: "2026-10-01T10:00:00Z",
  changed_at: "2026-10-12T12:30:00Z",
  authors: [
    { id: 3, username: "admin", full_name: "Ana Costa" },
    { id: 4, username: "luan", full_name: "" },
  ],
  published_blocks: {
    version: 1,
    blocks_order: ["p1"],
    blocks: { p1: { id: "p1", type: "paragraph", version: 1, attrs: { pm: { type: "paragraph", content: [{ type: "text", text: "Body text" }] } } } },
  },
}
const terms = [{ id: 1, name: "Editor", slug: "editor", taxonomy_type_name: "tag" }]

const request = new Request("http://web:4321/post/hello-world")
let container: AstroContainer

beforeEach(async () => {
  // React renders the post body (BlockRenderer).
  container = await AstroContainer.create({ renderers: await loadRenderers([reactRenderer()]) })
  getPostsByType.mockReset()
  getAdjacentPosts.mockReset().mockResolvedValue({ previous: null, next: null })
  getRelatedPosts.mockReset().mockResolvedValue([])
})

// A related/adjacent row (#351) as the API sends it: a with_meta list row.
const listRow = (id: number, title: string, extra: Record<string, unknown> = {}) => ({
  ...post,
  id,
  title,
  slug: `post-${id}`,
  published_blocks: undefined,
  meta: {},
  authors: [{ id: 5, username: "priya", full_name: "Priya Nair" }],
  ...extra,
})

// A published doc with these headings (level, text), each followed by a paragraph.
const docWithHeadings = (...headings: [number, string][]) => {
  const blocks: Record<string, unknown> = {}
  const order: string[] = []
  headings.forEach(([level, text], i) => {
    blocks[`h${i}`] = { id: `h${i}`, type: "heading", version: 1, attrs: { level, pm: { type: "heading", attrs: { level }, content: [{ type: "text", text }] } } }
    blocks[`p${i}`] = { id: `p${i}`, type: "paragraph", version: 1, attrs: { pm: { type: "paragraph", content: [{ type: "text", text: "Body" }] } } }
    order.push(`h${i}`, `p${i}`)
  })
  return { version: 1, blocks_order: order, blocks }
}

// Dev builds tag elements with data-astro-source-* (the dev toolbar); compare without them.
const render = async (component: any, props: Record<string, unknown>) =>
  (await container.renderToString(component, { props, request })).replace(/\s+data-astro-source-(?:file|loc)="[^"]*"/g, "")

describe("SiteHeader", () => {
  it("shows the site title as text, today's nav and the theme switch, no GoLive mark or search", async () => {
    const html = await render(SiteHeader, { siteTitle: "Field Notes", current: "posts" })
    expect(html).toMatch(/<a href="\/" class="site-title"[^>]*>Field Notes<\/a>/)
    expect(html).toMatch(/<a href="\/post" aria-current="page">Posts<\/a>/)
    expect(html).not.toContain("<svg width=\"16\" height=\"16\" viewBox=\"0 0 66 67\"")
    expect(html).not.toContain('role="search"')
    expect(html).toContain('href="#content"')
  })

  it("offers Light, Dark and System in the header menu and the phone menu alike", async () => {
    const html = await render(SiteHeader, { siteTitle: "Field Notes" })
    const choices = [...html.matchAll(/data-theme-choice="(\w+)"/g)].map((m) => m[1])
    expect(choices).toEqual(["light", "dark", "system", "light", "dark", "system"])
    expect(html).toContain('aria-controls="theme-menu"')
    expect(html).toMatch(/<dialog id="site-menu"[^>]*aria-label="Menu"/)
    expect(html).toMatch(/<a href="\/"[^>]*>Home<\/a>/)
  })
})

describe("SiteFooter", () => {
  it("credits GoLive with its logo, links the feed, and skips menus that don't exist", async () => {
    const html = await render(SiteFooter, { siteTitle: "Field Notes" })
    expect(html).toMatch(/class="golive-credit"[^>]*>\s*Published with\s*<svg[^>]*viewBox="0 0 66 67"[^>]*fill="currentColor"[^>]*aria-hidden="true"/)
    expect(html).toContain("<span>GoLive</span>")
    expect(html).toContain('href="/rss.xml"')
    expect(html).toContain(`© ${new Date().getFullYear()} Field Notes`)
    expect(html).not.toMatch(/Legal|Privacy|Topics/)
  })
})

describe("base layout", () => {
  it("loads the theme script from a file (no inline script), fonts locally, and the tokens", async () => {
    const html = await render(PostDefault, { post, title: "Hello World | Post", description: "x", siteTitle: "Field Notes" })
    const head = html.slice(0, html.indexOf("</head>"))
    expect(head).toMatch(/<script src="\/themes\/default\/scripts\/theme-init\.js" data-storage-key="gl-theme-preference"><\/script>/)
    expect(head.match(/<script\b[^>]*>[^<]+<\/script>/g)).toBeNull()
    expect(head).toContain('href="/themes/default/fonts/literata/literata-latin-opsz-normal.woff2"')
    expect(head).not.toMatch(/fonts\.(googleapis|gstatic)\.com/)
    expect(head).toContain("--color-primary:#1b7760;")
    expect(head).toContain('<link rel="alternate" type="application/rss+xml"')
    // No server-side data-theme: the script sets it, and without JS the CSS follows the system.
    expect(html).toMatch(/<html lang="en">/)
  })
})

describe("post layouts", () => {
  it("default: title, dek, byline, terms; no author pages; no TOC", async () => {
    const html = await render(PostDefault, { post, title: "t", description: "d", terms, featuredImage: "https://example.org/uploads/a.jpg", siteTitle: "Field Notes" })
    expect(html).toContain('<h1 class="title">Hello World</h1>')
    expect(html).toContain('<p class="dek">An excerpt</p>')
    expect(html).toContain("By Ana Costa and luan")
    expect(html).toContain('class="post-featured post-featured--wide"')
    expect(html).toContain("<p>Body text</p>")
    expect(html).toContain('<dd class="chip post-terms__term" data-slug="editor">Editor</dd>')
    expect(html).not.toMatch(/Written by|On this page/)
    expect(html).toMatch(/<a href="\/post" aria-current="page">Posts/)
  })

  it("default: older / newer posts and More to read (#351)", async () => {
    getAdjacentPosts.mockResolvedValue({ previous: listRow(41, "Analytics for every post"), next: listRow(43, "Scheduled updates") })
    getRelatedPosts.mockResolvedValue([listRow(7, "Roles explained", { meta: { _thumbnail_url: "/uploads/media/r.jpg" } }), listRow(8, "Blocks that survive")])
    const html = await render(PostDefault, { post, title: "t", description: "d", siteTitle: "Field Notes" })
    expect(getAdjacentPosts).toHaveBeenCalledWith(42)
    expect(getRelatedPosts).toHaveBeenCalledWith(42, { limit: 3 })
    // Links follow the site's URL structure (slug here).
    expect(html).toMatch(/<a href="\/post\/post-41" class="post-nav-link" rel="prev">\s*<span>← Older post<\/span>Analytics for every post/)
    expect(html).toMatch(/<a href="\/post\/post-43" class="post-nav-link is-next" rel="next">\s*<span>Newer post →<\/span>Scheduled updates/)
    expect(html).toMatch(/<h2 id="more-to-read" class="section-title">More to read<\/h2>/)
    expect(html).toMatch(/<h3 class="card-title"><a href="\/post\/post-7">Roles explained<\/a><\/h3>/)
    expect(html).toMatch(/<img class="media" src="[^"]*\/uploads\/media\/r\.jpg"/)
    expect(html).toContain("Priya Nair · Oct 1, 2026")
    // A card without a featured image has no image link.
    expect(html.match(/<img class="media"/g)).toHaveLength(1)
  })

  it("default: the newest post links back to the list; no related posts, no section", async () => {
    getAdjacentPosts.mockResolvedValue({ previous: null, next: null })
    const html = await render(PostDefault, { post, title: "t", description: "d", siteTitle: "Field Notes" })
    expect(html).toMatch(/<a href="\/post" class="post-nav-link is-next">\s*<span>Back to<\/span>All posts →/)
    expect(html).not.toMatch(/Older post|More to read/)
  })

  it("headings get ids that never take the theme's own (e.g. #content)", async () => {
    const withHeadings = { ...post, published_blocks: docWithHeadings([2, "Content"], [2, "How it works"]) }
    const html = await render(PostDefault, { post: withHeadings, title: "t", description: "d", siteTitle: "Field Notes" })
    expect(html).toContain('<h2 id="content-2">Content</h2>')
    expect(html).toContain('<h2 id="how-it-works">How it works</h2>')
    expect(html.match(/id="content"/g)).toHaveLength(1)
  })

  it("sidebar: On this page and the category's posts (#351)", async () => {
    const withHeadings = { ...post, published_blocks: docWithHeadings([2, "What changes"], [3, "For writers"], [2, "How it works"], [2, "What’s next"]) }
    const category = { id: 2, name: "Product updates", slug: "product-updates", taxonomy_type_name: "category" }
    getRelatedPosts.mockImplementation(async (_id: number, params: { termId?: number }) =>
      params.termId === 2 ? [listRow(41, "Analytics for every post")] : [listRow(7, "Roles explained")],
    )
    const html = await render(PostSidebar, { post: withHeadings, title: "t", description: "d", terms: [category, ...terms], siteTitle: "Field Notes" })
    expect(getRelatedPosts).toHaveBeenCalledWith(42, { limit: 3, termId: 2 })
    const aside = html.slice(html.indexOf('<aside class="post-aside"'), html.indexOf("</aside>"))
    expect(aside).toMatch(/<h2 id="toc-title" class="section-title">On this page<\/h2>/)
    expect(aside).toMatch(
      /<ol class="toc">\s*<li>\s*<a href="#what-changes">What changes<\/a>\s*<ol class="toc toc--nested">\s*<li><a href="#for-writers">For writers<\/a><\/li>\s*<\/ol>\s*<\/li>\s*<li>\s*<a href="#how-it-works">How it works<\/a>\s*<\/li>\s*<li>\s*<a href="#what-s-next">What’s next<\/a>/,
    )
    expect(html).toContain('<h3 id="for-writers">For writers</h3>')
    expect(aside).toMatch(/<h2 id="in-category" class="section-title">In Product updates<\/h2>/)
    expect(aside).toContain('<a href="/post/post-41">Analytics for every post</a>')
    // The dates move out of the aside once it has these; terms are at the post's end.
    expect(aside).not.toContain("Reading time")
    expect(html).toMatch(/<footer class="post-end">[\s\S]*data-slug="editor"/)
    expect(html).toContain("More to read")
  })

  it("sidebar: under three headings and no category, the aside holds the dates", async () => {
    const html = await render(PostSidebar, { post, title: "t", description: "d", terms, siteTitle: "Field Notes" })
    expect(html).toContain('class="post-grid"')
    expect(html).toMatch(/<aside class="post-aside" aria-label="About this post">/)
    expect(html).toContain("October 1, 2026")
    expect(html).toContain("October 12, 2026") // updated
    expect(html).not.toMatch(/On this page|In Editor/)
    expect(getRelatedPosts).toHaveBeenCalledTimes(1)
  })

  it("wide: centred header and a full-bleed featured image", async () => {
    const html = await render(PostWide, { post, title: "t", description: "d", featuredImage: "https://example.org/uploads/a.jpg", siteTitle: "Field Notes" })
    expect(html).toContain("post post--wide")
    expect(html).toMatch(/class="post-header wide is-centered"/)
    expect(html).toContain('class="post-featured post-featured--full"')
  })
})

describe("page layouts", () => {
  it("default: title over one column, no byline", async () => {
    const html = await render(PageDefault, { post: { ...post, post_type: "page" }, title: "t", description: "d", siteTitle: "Field Notes" })
    expect(html).toContain("page page--default")
    expect(html).not.toContain("byline")
    expect(html).not.toContain('aria-current="page"')
  })

  it("full width: a title band", async () => {
    const html = await render(PageFull, { post: { ...post, post_type: "page" }, title: "t", description: "d", siteTitle: "Field Notes" })
    expect(html).toMatch(/<header class="page-band">[\s\S]*<h1 class="title">Hello World<\/h1>/)
  })
})

describe("front page", () => {
  const item = (id: number, image: string | null = null) => ({ post: { ...post, id, title: `Post ${id}` }, href: `/post/p${id}`, image })

  it("features the latest post and lists the rest, with Older paging only", async () => {
    const list = { posts: [item(1, "https://example.org/uploads/1.jpg"), item(2), item(3)], total: 12, page: 1, links: { older: "/?page=2" }, siteTitle: "Field Notes" }
    const html = await render(Home, { title: "Field Notes", description: "d", list })
    expect(html).toContain('<h1 class="title">Field Notes</h1>')
    expect(html).toMatch(/class="feature has-media"[\s\S]*Post 1/)
    expect(html).toContain('<h2 id="more-posts" class="section-title list-heading">More posts</h2>')
    expect(html).toContain('<a href="/post/p3">Post 3</a>')
    expect(html).toContain('<a href="/?page=2" class="page-link" rel="next">Older →</a>')
    expect(html).toContain('<span class="page-link" aria-disabled="true">← Newer</span>')
    expect(html).not.toMatch(/page-num|Page 1 of/)
  })
})

describe("error layout", () => {
  it("404: lists recent posts at their slug URLs, no search form until #145", async () => {
    getPostsByType.mockResolvedValue({ data: [{ ...post, title: "Recent one" }], meta: {} })
    const html = await render(ErrorLayout, { status: 404, title: "Page not found", message: "Gone." })
    expect(html).toContain("This page isn’t here")
    expect(html).toContain('<a href="/post/hello-world">Recent one</a>')
    expect(html).not.toContain('role="search"')
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">')
  })

  it("500: offers to try again and makes no posts call", async () => {
    const html = await render(ErrorLayout, { status: 500, title: "Something went wrong", message: "Oops." })
    expect(html).toContain("Something went wrong on our side")
    expect(html).toContain("Try again")
    expect(getPostsByType).not.toHaveBeenCalled()
  })
})
