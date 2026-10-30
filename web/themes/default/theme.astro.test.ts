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
const TermLayout = (await import("./layouts/term/default.astro")).default
const SearchLayout = (await import("./layouts/search/default.astro")).default

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
  it("shows the site title as text, the theme switch, search and no GoLive mark", async () => {
    const html = await render(SiteHeader, { siteTitle: "Field Notes" })
    expect(html).toMatch(/<a href="\/" class="site-title"[^>]*>Field Notes<\/a>/)
    expect(html).not.toContain("<svg width=\"16\" height=\"16\" viewBox=\"0 0 66 67\"")
    expect(html).toContain('href="#content"')
    // The header's search link (#145) and the phone menu's field, a GET form to /search.
    expect(html).toContain('<a href="/search" class="icon-btn" aria-label="Search">')
    expect(html).toMatch(/<form role="search" class="search-form search-form--compact" action="\/search" method="get">/)
    expect(html).toMatch(/<label for="menu-q" class="sr-only">Search the blog<\/label>/)
    expect(html).toMatch(/<input id="menu-q" type="search" name="q"/)
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

describe("post term links (#348)", () => {
  // As the post route passes them: lib/termPage.ts linkTerms gave public ones an href.
  const category = { id: 2, name: "Product updates", slug: "product-updates", taxonomy_type_name: "category", taxonomy_label: "Categories", href: "/category/product-updates" }
  const linked = [category, { id: 1, name: "Editor", slug: "editor", taxonomy_type_name: "tag", taxonomy_label: "Tags", href: "/tag/editor" }]

  it("links the category eyebrow and the term chips to their archives", async () => {
    for (const Layout of [PostDefault, PostSidebar, PostWide]) {
      const html = await render(Layout, { post, title: "t", description: "d", terms: linked, siteTitle: "Field Notes" })
      expect(html).toMatch(/<header class="post-header[^"]*">\s*<a class="eyebrow" href="\/category\/product-updates">Product updates<\/a>\s*<h1/)
      expect(html).toContain('<dd class="post-terms__term" data-slug="editor"><a class="chip" href="/tag/editor">Editor</a></dd>')
      expect(html).toContain('<dt class="section-title">Categories</dt>')
    }
  })

  it("leaves a term without an archive (a non-public taxonomy) as plain text", async () => {
    const html = await render(PostDefault, { post, title: "t", description: "d", terms: [{ ...category, href: undefined }], siteTitle: "Field Notes" })
    expect(html).toContain('<span class="eyebrow">Product updates</span>')
    expect(html).toContain('<dd class="chip post-terms__term" data-slug="product-updates">Product updates</dd>')
    expect(html).not.toContain('href="/category/')
  })

  it("sidebar: All <category> links to its archive", async () => {
    getRelatedPosts.mockImplementation(async (_id: number, params: { termId?: number }) => (params.termId === 2 ? [listRow(41, "Analytics for every post")] : []))
    const html = await render(PostSidebar, { post, title: "t", description: "d", terms: linked, siteTitle: "Field Notes" })
    const aside = html.slice(html.indexOf('<aside class="post-aside"'), html.indexOf("</aside>"))
    expect(aside).toContain('<a class="aside-all" href="/category/product-updates">All Product updates →</a>')
  })
})

describe("term page (#348)", () => {
  const item = (id: number) => ({ post: { ...post, id, title: `Post ${id}` }, href: `/post/p${id}`, image: null })
  const category = { id: 2, name: "Product updates", slug: "product-updates", description: "What’s new in GoLive, when it ships.", taxonomy: "category", taxonomy_label: "Categories", hierarchical: true }
  const tag = { id: 3, name: "Collaboration", slug: "collaboration", description: "", taxonomy: "tag", taxonomy_label: "Tags", hierarchical: false }

  it("category: eyebrow, name, description and count, then the posts with the pager", async () => {
    const list = { posts: [item(1), item(2)], total: 14, page: 1, totalPages: 2, basePath: "/category/product-updates", links: { older: "/category/product-updates/page/2/" }, siteTitle: "Field Notes" }
    const html = await render(TermLayout, { term: category, postCount: 14, list, title: "Product updates | Field Notes", description: "d" })
    expect(html).toMatch(/<header class="archive-header term-header">\s*<span class="eyebrow">Category<\/span>\s*<h1 class="title">Product updates<\/h1>\s*<p class="dek">What’s new in GoLive, when it ships\.<\/p>\s*<p class="meta">14 posts<\/p>/)
    expect(html).toContain('<h2 class="post-item-title"><a href="/post/p2">Post 2</a></h2>')
    expect(html).toContain('<a href="/category/product-updates/page/2/" class="page-link" rel="next">Older →</a>')
    expect(html).not.toContain("That’s every post")
  })

  it("tag: no description, the tagged count line, and the list end on one page", async () => {
    const list = { posts: [item(1)], total: 4, page: 1, totalPages: 1, basePath: "/tag/collaboration", links: {}, siteTitle: "Field Notes" }
    const html = await render(TermLayout, { term: tag, postCount: 4, list, title: "t", description: "d" })
    expect(html).toContain('<span class="eyebrow">Tag</span>')
    expect(html).not.toContain('class="dek"')
    expect(html).toContain("4 posts tagged Collaboration")
    expect(html).toContain('That’s every post tagged Collaboration. <a href="/">Back to all posts</a>')
    expect(html).not.toContain('class="pagination"')
  })

  it("page N says so; an empty term says nothing has been published", async () => {
    const paged = { posts: [item(11)], total: 14, page: 2, totalPages: 2, basePath: "/category/product-updates", links: { newer: "/category/product-updates" }, siteTitle: "Field Notes" }
    expect(await render(TermLayout, { term: category, postCount: 14, list: paged, title: "t", description: "d" })).toContain("Page 2 · 14 posts")
    const empty = { posts: [], total: 0, page: 1, totalPages: 0, basePath: "/tag/collaboration", links: {}, siteTitle: "Field Notes" }
    const html = await render(TermLayout, { term: tag, postCount: 0, list: empty, title: "t", description: "d" })
    expect(html).toContain("0 posts tagged Collaboration")
    expect(html).toContain("Nothing has been published here yet.")
    expect(html).not.toContain("That’s every post")
  })
})

describe("error layout", () => {
  it("404: a search form and recent posts at their slug URLs", async () => {
    getPostsByType.mockResolvedValue({ data: [{ ...post, title: "Recent one" }], meta: {} })
    const html = await render(ErrorLayout, { status: 404, title: "Page not found", message: "Gone." })
    expect(html).toContain("This page isn’t here")
    expect(html).toContain('<a href="/post/hello-world">Recent one</a>')
    expect(html).toMatch(/<form role="search" class="search-form" action="\/search" method="get">/)
    expect(html).toMatch(/<input id="q404" type="search" name="q"/)
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

describe("search layout (#145)", () => {
  const chips = (current: "all" | "post" | "page", q = "alt text") =>
    (["all", "post", "page"] as const).map((type, i) => ({
      type,
      label: ["All", "Posts", "Pages"][i],
      count: [4, 3, 1][i],
      href: type === "all" ? `/search?q=${encodeURIComponent(q)}` : `/search?q=${encodeURIComponent(q)}&type=${type}`,
      current: type === current,
    }))
  const result = (id: number, extra: Record<string, unknown> = {}) => ({
    hit: { id, title: "Writing alt text", slug: "writing-alt-text", post_type: "post", created_at: "", changed_at: "", title_html: "", excerpt_html: "" },
    href: "/post/writing-alt-text",
    typeLabel: "Post",
    dateLabel: "Oct 15, 2026",
    titleHtml: "Writing <mark>alt</mark> <mark>text</mark> that helps",
    excerptHtml: "…good <mark>alt</mark> &amp; more…",
    ...extra,
  })
  const data = (extra: Record<string, unknown> = {}) => ({
    query: "alt text",
    type: "all",
    results: [result(1), result(2, { typeLabel: "Page", dateLabel: "Updated Sep 30, 2026", href: "/accessibility" })],
    counts: { all: 4, post: 3, page: 1 },
    chips: chips("all"),
    total: 4,
    page: 1,
    totalPages: 1,
    basePath: "/search",
    pageQuery: "?q=alt+text",
    siteTitle: "Field Notes",
    topics: [],
    recent: [],
    title: "Search: alt text | Field Notes",
    description: "Search Field Notes",
    seo: { noindex: true },
    ...extra,
  })

  it("renders the results: count, type chips, marked title and excerpt, the URL path", async () => {
    const html = await render(SearchLayout, data())
    expect(html).toMatch(/<input id="search-q" type="search" name="q" class="input" value="alt text"/)
    expect(html).toContain("<strong>4 results</strong> for “alt text”")
    expect(html).toMatch(/<a href="\/search\?q=alt%20text" class="chip" aria-current="page">\s*All <span class="chip-count">4<\/span>\s*<\/a>/)
    expect(html).toMatch(/<a href="\/search\?q=alt%20text&#38;type=post" class="chip">\s*Posts <span class="chip-count">3<\/span>\s*<\/a>/)
    expect(html).toContain('<a href="/post/writing-alt-text">Writing <mark>alt</mark> <mark>text</mark> that helps</a>')
    expect(html).toContain('<p class="search-result-excerpt">…good <mark>alt</mark> &amp; more…</p>')
    expect(html).toContain('<span class="search-result-path">/accessibility</span>')
    expect(html).toContain("Updated Sep 30, 2026")
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">')
    expect(html).not.toContain("No results for")
    expect(html).not.toContain('class="pagination"')
  })

  it("pages with the query kept on every link", async () => {
    const html = await render(SearchLayout, data({ page: 2, totalPages: 3, pageQuery: "?q=alt+text&type=post" }))
    expect(html).toContain('<a href="/search?q=alt+text&#38;type=post" class="page-link" rel="prev">← Previous</a>')
    expect(html).toContain('<a href="/search/page/3/?q=alt+text&#38;type=post" class="page-link" rel="next">Next →</a>')
    expect(html).toContain("· Page 2")
  })

  it("the empty state: no results for the query, tips, topics and recent posts", async () => {
    const html = await render(SearchLayout, data({
      query: "quantum editing",
      results: [],
      counts: { all: 0, post: 0, page: 0 },
      chips: chips("all", "quantum editing"),
      total: 0,
      topics: [{ label: "Guides", href: "/category/guides" }],
      recent: [{ label: "Recent one", href: "/post/recent-one" }],
    }))
    expect(html).toContain("No results for “quantum editing”")
    expect(html).toContain("Check the spelling, or try fewer words.")
    expect(html).toContain('<a href="/category/guides" class="chip">Guides</a>')
    expect(html).toContain('<a href="/post/recent-one">Recent one</a>')
    expect(html).not.toContain("search-results")
    expect(html).not.toContain('aria-label="Filter results"')
  })

  it("an empty query shows the form alone", async () => {
    const html = await render(SearchLayout, data({ query: "", results: [], total: 0 }))
    expect(html).toContain('class="search-form"')
    expect(html).not.toContain("No results for")
    expect(html).not.toContain("search-results")
  })

  it("never reflects the query as markup", async () => {
    const query = '"><script>alert(1)</script><img src=x onerror=alert(2)>'
    const html = await render(SearchLayout, data({ query, title: `Search: ${query} | Field Notes`, results: [], total: 0, topics: [], recent: [] }))
    // In the field's value the quote is escaped, so the attribute can't be closed
    // (< and > are inert inside a quoted attribute).
    const value = 'value="&#34;><script>alert(1)</script><img src=x onerror=alert(2)>"'
    expect(html).toContain(value)
    // Everywhere else (attribute values aside, where the quote is escaped too) it is text.
    const outsideValue = html.replace(/="[^"]*"/g, "")
    expect(outsideValue).not.toContain("<script>alert(1)")
    expect(outsideValue).not.toContain("<img src=x")
    expect(html).toContain("No results for “&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;”")
    // The <title> too.
    expect(html).not.toMatch(/<title>[^<]*<script/)
  })
})
