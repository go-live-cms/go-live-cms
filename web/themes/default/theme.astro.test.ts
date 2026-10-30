// Renders the default theme's header, footer and layouts with Astro's Container API
// (#345) and checks what readers get: the switch, the credit, the hidden parts.
import { experimental_AstroContainer as AstroContainer } from "astro/container"
import { getContainerRenderer as reactRenderer } from "@astrojs/react"
import { loadRenderers } from "astro:container"
import { beforeEach, describe, expect, it, vi } from "vitest"

// The site settings (#330); a test may change them for one render.
const SITE = { title: "Field Notes", tagline: "", postsPerPage: 10, urlStructure: "slug", language: "en-US", timeZone: "UTC", dateFormat: "month_day_year" }
const getSiteSettings = vi.fn()
vi.mock("@/lib/siteSettings", () => ({
  getSiteSettings: (...args: unknown[]) => getSiteSettings(...args),
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
  getAdjacentPosts.mockReset().mockResolvedValue({ previous: null, next: null })
  getRelatedPosts.mockReset().mockResolvedValue([])
  getMenu.mockReset()
  getSiteSettings.mockReset().mockResolvedValue(SITE)
  getMenu.mockResolvedValue(null)
})

const link = (id: number, label: string, url: string, children: unknown[] = [], current = false) => ({ id, label, url, children, current })

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
    expect(html).toMatch(/<html lang="en-US">/)
  })

  it("sets <html lang> from the site language (#330)", async () => {
    getSiteSettings.mockResolvedValue({ ...SITE, language: "pt-BR" })
    const html = await render(PostDefault, { post, title: "t", description: "d", siteTitle: "Field Notes" })
    expect(html).toMatch(/<html lang="pt-BR">/)
  })

  it("shows the tagline in the footer and as the description of a page without one (#330)", async () => {
    getSiteSettings.mockResolvedValue({ ...SITE, tagline: "Notes from the team building GoLive" })
    const html = await render(PostDefault, { post, title: "t", description: "", siteTitle: "Field Notes" })
    expect(html).toContain('<p class="site-tagline">Notes from the team building GoLive</p>')
    const head = html.slice(0, html.indexOf("</head>"))
    expect(head).toContain('<meta name="description" content="Notes from the team building GoLive">')
    expect(head).toContain('<meta property="og:description" content="Notes from the team building GoLive">')
    expect(head).toContain('<meta property="og:site_name" content="Field Notes">')
    // A page with its own description keeps it.
    const own = await render(PostDefault, { post, title: "t", description: "Its own", siteTitle: "Field Notes" })
    expect(own).toContain('<meta name="description" content="Its own">')
  })

  it("has no tagline line without a tagline", async () => {
    const html = await render(PostDefault, { post, title: "t", description: "d", siteTitle: "Field Notes" })
    expect(html).not.toContain("site-tagline")
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
  it("default: title, dek, byline, terms; no TOC", async () => {
    const html = await render(PostDefault, { post, title: "t", description: "d", terms, featuredImage: "https://example.org/uploads/a.jpg", siteTitle: "Field Notes" })
    expect(html).toContain('<h1 class="title">Hello World</h1>')
    expect(html).toContain('<p class="dek">An excerpt</p>')
    expect(html).toContain('By <a href="/author/admin">Ana Costa</a> and <a href="/author/luan">luan</a>')
    expect(html).toContain('class="post-featured post-featured--wide"')
    expect(html).toContain("<p>Body text</p>")
    expect(html).toContain('<dd class="chip post-terms__term" data-slug="editor">Editor</dd>')
    // No "Written by" without the route's authors.
    expect(html).not.toMatch(/Written by|On this page/)
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
      // The design's order: tags, Written by, then older / newer (#351).
      expect(html.indexOf('id="written-by"')).toBeLessThan(html.indexOf('class="post-nav"'))
    }
  })

  it("a post without a byline shows its owner, unlinked", async () => {
    const html = await render(PostDefault, { post: { ...post, authors: [] }, title: "t", description: "d", siteTitle: "Field Notes" })
    expect(html).toContain("<span>By admin</span>")
    expect(html).not.toContain("/author/")
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

describe("dates (#330)", () => {
  it("bylines and the sidebar facts use the site language, time zone and date format", async () => {
    getSiteSettings.mockResolvedValue({ ...SITE, language: "pt-BR", timeZone: "America/Sao_Paulo", dateFormat: "day_month_year" })
    // 2026-10-01T10:00Z is 07:00 in São Paulo: still 1 October.
    const html = await render(PostSidebar, { post: { ...post, published_blocks: docWithHeadings() }, title: "t", description: "d", siteTitle: "Field Notes" })
    expect(html).toContain("1 de outubro de 2026")
    expect(html).toContain("12 de outubro de 2026")
    expect(html).not.toContain("October")
  })

  it("the ISO preset is the same in any language, and the day is the site zone's", async () => {
    getSiteSettings.mockResolvedValue({ ...SITE, language: "de-DE", timeZone: "Pacific/Auckland", dateFormat: "iso" })
    // 10:00Z on Oct 1 is 23:00 the same day in Auckland (UTC+13); 12:30Z on Oct 12 is 01:30 on Oct 13.
    const html = await render(PostSidebar, { post: { ...post, published_blocks: docWithHeadings() }, title: "t", description: "d", siteTitle: "Field Notes" })
    expect(html).toContain("2026-10-01")
    expect(html).toContain("2026-10-13")
  })
})

describe("front page", () => {
  const item = (id: number, image: string | null = null) => ({ post: { ...post, id, title: `Post ${id}` }, href: `/post/p${id}`, image })

  it("features the latest post and lists the rest, with the numbered pager", async () => {
    const list = { posts: [item(1, "https://example.org/uploads/1.jpg"), item(2), item(3)], total: 12, page: 1, totalPages: 5, basePath: "/", links: { older: "/page/2/" }, siteTitle: "Field Notes" }
    const html = await render(Home, { title: "Field Notes", description: "d", list })
    expect(html).toContain('<h1 class="title">Field Notes</h1>')
    expect(html).not.toContain('<p class="dek">')
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

  it("puts the tagline under the title on the first page only (#330)", async () => {
    const list = { posts: [item(1)], total: 1, page: 1, totalPages: 1, basePath: "/", links: {}, siteTitle: "Field Notes", siteTagline: "Notes from the team" }
    expect(await render(Home, { title: "Field Notes", description: "d", list })).toMatch(/<h1 class="title">Field Notes<\/h1>\s*<p class="dek">Notes from the team<\/p>/)
    const page2 = { ...list, page: 2, totalPages: 2, links: { newer: "/" } }
    const html = await render(Home, { title: "Field Notes", description: "d", list: page2 })
    expect(html).toContain('<p class="dek">Page 2</p>')
    expect(html).not.toContain("Notes from the team</p>")
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

  it("500: offers to try again and makes no posts or menus call", async () => {
    const html = await render(ErrorLayout, { status: 500, title: "Something went wrong", message: "Oops." })
    expect(html).toContain("Something went wrong on our side")
    expect(html).toContain("Try again")
    expect(getPostsByType).not.toHaveBeenCalled()
    expect(getMenu).not.toHaveBeenCalled()
  })
})
