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

// The menus assigned to the theme's locations (#347); none unless a test sets them.
const getMenu = vi.fn()
vi.mock("@/lib/menus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/menus")>()),
  getMenu: (location: string) => getMenu(location),
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
  getMenu.mockReset()
  getMenu.mockResolvedValue(null)
})

const link = (id: number, label: string, url: string, children: unknown[] = [], current = false) => ({ id, label, url, children, current })

// Dev builds tag elements with data-astro-source-* (the dev toolbar); compare without them.
const render = async (component: any, props: Record<string, unknown>) =>
  (await container.renderToString(component, { props, request })).replace(/\s+data-astro-source-(?:file|loc)="[^"]*"/g, "")

describe("SiteHeader", () => {
  it("shows the site title as text, the theme switch, no GoLive mark or search", async () => {
    const html = await render(SiteHeader, { siteTitle: "Field Notes" })
    expect(html).toMatch(/<a href="\/" class="site-title"[^>]*>Field Notes<\/a>/)
    expect(html).not.toContain("<svg width=\"16\" height=\"16\" viewBox=\"0 0 66 67\"")
    expect(html).not.toContain('role="search"')
    expect(html).toContain('href="#content"')
  })

  it("without a primary menu: the site title only, no nav", async () => {
    const html = await render(SiteHeader, { siteTitle: "Field Notes" })
    expect(html).not.toContain('class="site-nav"')
    // The phone menu keeps Home and the theme switch.
    const phone = html.slice(html.indexOf("<dialog"))
    expect([...phone.matchAll(/<nav[\s\S]*?<\/nav>/g)][0][0].match(/<a /g)).toHaveLength(1)
  })

  it("with a primary menu: its links in the nav and the phone menu, children under their parent", async () => {
    const menu = [
      link(1, "Guides", "/category/guides", [link(2, "Setup", "/page/setup", [], true)]),
      link(3, "About", "/page/about"),
      link(4, "GitHub", "https://github.com/go-live-cms"),
    ]
    const html = await render(SiteHeader, { siteTitle: "Field Notes", menu })
    const nav = html.slice(html.indexOf('<nav class="site-nav"'), html.indexOf("</nav>"))
    expect(nav).toMatch(/<div class="nav-group" data-nav-group data-current="true">\s*<a href="\/category\/guides">Guides<\/a>/)
    expect(nav).toMatch(/aria-expanded="false" aria-controls="nav-sub-1" aria-label="Guides: more links"/)
    expect(nav).toMatch(/<ul id="nav-sub-1" class="nav-submenu" role="list">\s*<li><a href="\/page\/setup" aria-current="page">Setup<\/a><\/li>/)
    expect(nav).toContain('<a href="/page/about">About</a>')
    expect(nav).toContain('<a href="https://github.com/go-live-cms">GitHub</a>')

    const phone = html.slice(html.indexOf("<dialog"))
    expect(phone).toMatch(/<a href="\/category\/guides">Guides<\/a>\s*<ul class="mobile-submenu" role="list">\s*<li><a href="\/page\/setup" aria-current="page">Setup<\/a>/)
    expect(phone).toContain('<a href="/page/about">About</a>')
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
    expect(html).toMatch(/<h2 id="footer-site">Site<\/h2>\s*<a href="\/rss.xml">RSS feed<\/a>/)
  })

  it("turns the footer menu into columns: parents with children head one, the rest go under Site", async () => {
    const menu = [
      link(1, "About", "/page/about"),
      link(2, "Legal", "/page/legal", [link(3, "Privacy", "/page/privacy"), link(4, "Terms", "/page/terms")]),
    ]
    const html = await render(SiteFooter, { siteTitle: "Field Notes", menu })
    expect(html).toMatch(/<h2 id="footer-site">Site<\/h2>\s*<a href="\/page\/about">About<\/a>\s*<a href="\/rss.xml">RSS feed<\/a>/)
    expect(html).toMatch(/<h2 id="footer-col-1"><a href="\/page\/legal" class="footer-heading">Legal<\/a><\/h2>\s*<a href="\/page\/privacy">Privacy<\/a>\s*<a href="\/page\/terms">Terms<\/a>/)
    expect(html.indexOf("footer-site")).toBeLessThan(html.indexOf("footer-col-1"))
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

  it("renders the menus assigned to primary and footer, marking the current page", async () => {
    getMenu.mockImplementation(async (location: string) =>
      location === "primary"
        ? { name: "Main", location, items: [link(1, "Hello", "/post/hello-world"), link(2, "About", "/page/about")] }
        : { name: "Footer", location, items: [link(3, "Privacy", "/page/privacy")] },
    )
    const html = await render(PostDefault, { post, title: "t", description: "d", siteTitle: "Field Notes" })
    expect(getMenu.mock.calls.map((c) => c[0]).sort()).toEqual(["footer", "primary"])
    // The request is /post/hello-world.
    expect(html).toMatch(/<nav class="site-nav" aria-label="Main">\s*<a href="\/post\/hello-world" aria-current="page">Hello<\/a>\s*<a href="\/page\/about">About<\/a>/)
    expect(html).toMatch(/<h2 id="footer-site">Site<\/h2>\s*<a href="\/page\/privacy">Privacy<\/a>/)
  })
})

describe("post layouts", () => {
  it("default: title, dek, byline, terms; no author pages or related posts", async () => {
    const html = await render(PostDefault, { post, title: "t", description: "d", terms, featuredImage: "https://example.org/uploads/a.jpg", siteTitle: "Field Notes" })
    expect(html).toContain('<h1 class="title">Hello World</h1>')
    expect(html).toContain('<p class="dek">An excerpt</p>')
    expect(html).toContain("By Ana Costa and luan")
    expect(html).toContain('class="post-featured post-featured--wide"')
    expect(html).toContain("<p>Body text</p>")
    expect(html).toContain('<dd class="chip post-terms__term" data-slug="editor">Editor</dd>')
    expect(html).not.toMatch(/More to read|Written by|Older post|On this page/)
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

  it("500: offers to try again and makes no posts or menus call", async () => {
    const html = await render(ErrorLayout, { status: 500, title: "Something went wrong", message: "Oops." })
    expect(html).toContain("Something went wrong on our side")
    expect(html).toContain("Try again")
    expect(getPostsByType).not.toHaveBeenCalled()
    expect(getMenu).not.toHaveBeenCalled()
  })
})
