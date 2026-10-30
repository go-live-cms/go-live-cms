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
vi.mock("@/lib/api", () => ({
  getTaxonomyTypes: async () => [{ name: "tag", label: "Tags" }],
  getPostsByType: (...args: unknown[]) => getPostsByType(...args),
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
const AuthorLayout = (await import("./layouts/author/default.astro")).default

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
// The "Written by" authors the post route fetches (#350): public fields only.
const authors = [
  { username: "admin", full_name: "Ana Costa", avatar: null, bio: "Edits this blog.\nAnd most docs.", website: "https://anacosta.example" },
  { username: "luan", full_name: "", avatar: null, bio: "", website: "" },
]

const request = new Request("http://web:4321/post/hello-world")
let container: AstroContainer

beforeEach(async () => {
  // React renders the post body (BlockRenderer).
  container = await AstroContainer.create({ renderers: await loadRenderers([reactRenderer()]) })
  getPostsByType.mockReset()
})

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
  it("default: title, dek, byline, terms; no related posts", async () => {
    const html = await render(PostDefault, { post, title: "t", description: "d", terms, featuredImage: "https://example.org/uploads/a.jpg", siteTitle: "Field Notes" })
    expect(html).toContain('<h1 class="title">Hello World</h1>')
    expect(html).toContain('<p class="dek">An excerpt</p>')
    expect(html).toContain('By <a href="/author/admin">Ana Costa</a> and <a href="/author/luan">luan</a>')
    expect(html).toContain('class="post-featured post-featured--wide"')
    expect(html).toContain("<p>Body text</p>")
    expect(html).toContain('<dd class="chip post-terms__term" data-slug="editor">Editor</dd>')
    // No "Written by" without the route's authors.
    expect(html).not.toMatch(/More to read|Written by|Older post|On this page/)
    expect(html).toMatch(/<a href="\/post" aria-current="page">Posts/)
  })

  it("ends with Written by cards that link to each author page (#350)", async () => {
    for (const Layout of [PostDefault, PostSidebar, PostWide]) {
      const html = await render(Layout, { post: { ...post, authors: undefined }, authors, title: "t", description: "d", siteTitle: "Field Notes" })
      expect(html).toMatch(/<section class="author-cards" aria-labelledby="written-by">\s*<h2 id="written-by" class="section-title">Written by<\/h2>/)
      expect(html).toContain('<h3><a href="/author/admin">Ana Costa</a></h3>')
      expect(html).toContain('<p class="author-bio">Edits this blog.\nAnd most docs.</p>')
      expect(html).toContain('<h3><a href="/author/luan">luan</a></h3>')
      // The byline names the same credited authors, linked.
      expect(html).toContain('<a href="/author/admin">Ana Costa</a> and <a href="/author/luan">luan</a>')
      // Cards show the bio only: the website is on the author page.
      expect(html).not.toContain("anacosta.example")
    }
  })

  it("a post without a byline shows its owner, unlinked", async () => {
    const html = await render(PostDefault, { post: { ...post, authors: [] }, title: "t", description: "d", siteTitle: "Field Notes" })
    expect(html).toContain("<span>By admin</span>")
    expect(html).not.toContain("/author/")
  })

  it("sidebar: the aside holds the dates and terms", async () => {
    const html = await render(PostSidebar, { post, title: "t", description: "d", terms, siteTitle: "Field Notes" })
    expect(html).toContain('class="post-grid"')
    expect(html).toMatch(/<aside class="post-aside" aria-label="About this post">/)
    expect(html).toContain("October 1, 2026")
    expect(html).toContain("October 12, 2026") // updated
    expect(html).not.toContain("On this page")
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

  it("features the latest post and lists the rest, with the numbered pager", async () => {
    const list = { posts: [item(1, "https://example.org/uploads/1.jpg"), item(2), item(3)], total: 12, page: 1, totalPages: 5, basePath: "/", links: { older: "/page/2/" }, siteTitle: "Field Notes" }
    const html = await render(Home, { title: "Field Notes", description: "d", list })
    expect(html).toContain('<h1 class="title">Field Notes</h1>')
    expect(html).toMatch(/class="feature has-media"[\s\S]*Post 1/)
    expect(html).toContain('<h2 id="more-posts" class="section-title list-heading">More posts</h2>')
    expect(html).toContain('<a href="/post/p3">Post 3</a>')
    expect(html).toContain('<span class="page-link" aria-disabled="true">← Newer</span>')
    expect(html).toContain('<a href="/" class="page-link page-num" aria-current="page">1</a>')
    expect(html).toContain('<a href="/page/3/" class="page-link page-num">3</a>')
    expect(html).toContain('<span class="page-link page-num" aria-hidden="true">…</span>')
    expect(html).toContain('<a href="/page/5/" class="page-link page-num">5</a>')
    expect(html).not.toContain('href="/page/4/"')
    expect(html).toContain('<span class="page-status">Page 1 of 5</span>')
    expect(html).toContain('<a href="/page/2/" class="page-link" rel="next">Older →</a>')
    const head = html.slice(0, html.indexOf("</head>"))
    expect(head).toContain('<link rel="canonical" href="http://web:4321/">')
    expect(head).toContain('<link rel="next" href="http://web:4321/page/2/">')
    expect(head).not.toContain('rel="prev"')
  })

  it("links back to newer pages and has no pager for a single page", async () => {
    const page3 = { posts: [item(9)], total: 21, page: 3, totalPages: 3, basePath: "/", links: { newer: "/page/2/" }, siteTitle: "Field Notes" }
    const html = await render(Home, { title: "Field Notes · Page 3", description: "d", list: page3 })
    expect(html).toContain('<a href="/page/2/" class="page-link" rel="prev">← Newer</a>')
    expect(html).toContain('<span class="page-link" aria-disabled="true">Older →</span>')
    expect(html).toContain('<link rel="canonical" href="http://web:4321/page/3/">')
    expect(html).toContain('<link rel="prev" href="http://web:4321/page/2/">')

    const single = { posts: [item(1)], total: 1, page: 1, totalPages: 1, basePath: "/", links: {}, siteTitle: "Field Notes" }
    expect(await render(Home, { title: "Field Notes", description: "d", list: single })).not.toContain('class="pagination"')
  })
})

describe("author page", () => {
  const item = (id: number) => ({ post: { ...post, id, title: `Post ${id}` }, href: `/post/p${id}`, image: null })
  const author = authors[0]

  it("shows the name, initial, bio, website (rel=me) and post count, then the posts", async () => {
    const list = { posts: [item(1), item(2)], total: 2, page: 1, totalPages: 1, basePath: "/author/ana", links: {}, siteTitle: "Field Notes" }
    const html = await render(AuthorLayout, { author, postCount: 2, list, title: "Ana Costa | Field Notes", description: "d" })
    expect(html).toContain('<span class="eyebrow">Author</span>')
    expect(html).toContain('<h1 class="title">Ana Costa</h1>')
    expect(html).toMatch(/<span class="avatar author-header__avatar" aria-hidden="true" style="background:#[0-9a-f]{6}">A<\/span>/)
    expect(html).toContain('<p class="dek author-bio">Edits this blog.\nAnd most docs.</p>')
    expect(html).toContain('<a href="https://anacosta.example/" rel="me noopener">anacosta.example</a>')
    expect(html).toContain("2 posts")
    expect(html).toContain('<a href="/post/p2">Post 2</a>')
    expect(html).toContain("That’s every post by Ana Costa.")
    expect(html).not.toContain('class="pagination"')
  })

  it("pages with the numbered pager and leaves out an unsafe or empty website", async () => {
    const list = { posts: [item(11)], total: 25, page: 2, totalPages: 3, basePath: "/author/admin", links: { newer: "/author/admin", older: "/author/admin/page/3/" }, siteTitle: "Field Notes" }
    const html = await render(AuthorLayout, { author: { ...author, bio: "", website: "javascript:alert(1)" }, postCount: 25, list, title: "t", description: "d" })
    expect(html).toContain("Page 2 · 25 posts")
    expect(html).toContain('<a href="/author/admin/page/3/" class="page-link" rel="next">Older →</a>')
    expect(html).toContain('<a href="/author/admin" class="page-link" rel="prev">← Newer</a>')
    expect(html).toContain('<a href="/author/admin/page/2/" class="page-link page-num" aria-current="page">2</a>')
    expect(html).not.toContain("javascript:")
    expect(html).not.toContain("author-bio")
    expect(html).not.toContain("every post by")
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
