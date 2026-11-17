import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import type { Post } from "@gl-admin/lib/api/types"
import BlockRenderer from "../BlockRenderer"
import type { SitePostItem, SitePostList, SiteRenderContext, SiteRoute, SiteRoutePost } from "./utils/siteContext"

// Site blocks IV (#498, design theme-builder.md 5.7): the pieces of the default theme's layouts
// the other site blocks didn't cover, and the new attrs of the others. Their markup on full pages
// is compared with the theme's code layouts in themes/default/theme.astro.test.ts (the parity
// check); these are the cases those fixtures don't have.

type B = { id: string; type: string; version: 1; attrs: Record<string, unknown>; children?: string[] }
const b = (id: string, type: string, attrs: Record<string, unknown> = {}, children?: string[]): B => ({ id, type, version: 1, attrs, ...(children ? { children } : {}) })
const docOf = (order: string[], ...blocks: B[]): BlockDocV1 =>
  ({ doc_version: 1, blocks_order: order, blocks: Object.fromEntries(blocks.map((x) => [x.id, x])) }) as unknown as BlockDocV1
const heading = (id: string, text: string) => b(id, "heading", { level: 2, pm: { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] } })

function post(id: number, title: string, extra: Partial<Post> = {}): Post {
  return {
    id,
    title,
    description: "",
    slug: title.toLowerCase().replace(/\s+/g, "-"),
    post_type: "post",
    post_status: "published",
    user_id: 1,
    username: "ana",
    created_at: "2026-10-18T12:00:00Z",
    changed_at: "2026-11-02T09:00:00Z",
    authors: [{ id: 1, username: "ana", full_name: "Ana Costa", avatar: null }],
    ...extra,
  } as unknown as Post
}
const item = (p: Post, image: string | null = null): SitePostItem => ({ post: p, href: `/post/${p.slug}`, image })
const list = (items: SitePostItem[], extra: Partial<SitePostList> = {}): SitePostList => ({ items, page: 1, totalPages: 1, basePath: "/post", total: items.length, ...extra })

function context(route: SiteRoute | undefined, overrides: Partial<SiteRenderContext> = {}): SiteRenderContext {
  return {
    inTemplate: true,
    kind: "template",
    site: { title: "Field Notes", tagline: "Notes from the team" },
    logo: null,
    menusByLocation: {},
    menusById: {},
    parts: {},
    dates: { language: "en-US", timeZone: "UTC", dateFormat: "month_day_year" },
    ...(route ? { route } : {}),
    ...overrides,
  }
}
const render = (doc: BlockDocV1, site: SiteRenderContext | null) => renderToStaticMarkup(<BlockRenderer doc={doc} site={site} anchors={false} />)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-11-14T12:00:00Z"))
})
afterEach(() => vi.useRealTimers())

describe("the new blocks render nothing outside a template", () => {
  it.each(["query_total", "author_avatar", "search_results", "post_facts", "site_copyright", "golive_credit"])("%s", (type) => {
    expect(render(docOf(["blk-0000001"], b("blk-0000001", type)), null)).toBe('<div class="block-content"></div>')
  })
})

describe("query_total", () => {
  const route: SiteRoute = { kind: "archive", count: "12 items", list: list([], { page: 2, totalPages: 2 }) }
  it("says how many, with the page after page 1", () => {
    expect(render(docOf(["total-00001"], b("total-00001", "query_total")), context(route))).toContain('<p class="meta">Page 2 · 12 items</p>')
    expect(render(docOf(["total-00001"], b("total-00001", "query_total")), context({ ...route, list: list([]) }))).toContain('<p class="meta">12 items</p>')
  })
  it("adds an author's website, and nothing where the route counts nothing", () => {
    const author: SiteRoute = { kind: "author", count: "2 posts", list: list([]), author: { name: "Ana", website: "https://ana.example/", websiteLabel: "ana.example" } }
    expect(render(docOf(["total-00001"], b("total-00001", "query_total")), context(author))).toContain('2 posts · <a href="https://ana.example/" rel="me noopener">ana.example</a>')
    expect(render(docOf(["total-00001"], b("total-00001", "query_total")), context({ kind: "search", search: { query: "x" } }))).toBe('<div class="block-content"></div>')
  })
})

describe("author_avatar", () => {
  it("the initial on the author's colour, or only an API avatar path", () => {
    const route = (avatar: string | null): SiteRoute => ({ kind: "author", author: { name: "Ana Costa", username: "ana", avatar } })
    expect(render(docOf(["avatar-0001"], b("avatar-0001", "author_avatar")), context(route(null)))).toMatch(/<span class="avatar author-header__avatar" aria-hidden="true" style="background:#[0-9a-f]{6}">A<\/span>/)
    expect(render(docOf(["avatar-0001"], b("avatar-0001", "author_avatar")), context(route("javascript:alert(1)")))).not.toContain("javascript:")
    expect(render(docOf(["avatar-0001"], b("avatar-0001", "author_avatar")), context({ kind: "archive" }))).toBe('<div class="block-content"></div>')
  })
})

describe("search_results", () => {
  const search = (extra: Record<string, unknown>): SiteRoute => ({
    kind: "search",
    search: { query: "alt", total: 0, totalLabel: "0 results", page: 1, totalPages: 0, basePath: "/search", pageQuery: "?q=alt", chips: [], results: [], topics: [], recent: [], ...extra },
  })
  it("says what to try when nothing matches, with the query as text only", () => {
    const html = render(docOf(["results-001"], b("results-001", "search_results")), context(search({ query: "<b>x</b>", topics: [{ label: "Guides", href: "/category/guides" }] })))
    expect(html).toContain("No results for “&lt;b&gt;x&lt;/b&gt;”")
    expect(html).toContain('<a href="/category/guides" class="chip">Guides</a>')
    expect(html).not.toContain("search-recent")
  })
  it("renders nothing for an empty query", () => {
    expect(render(docOf(["results-001"], b("results-001", "search_results")), context(search({ query: "" })))).toBe('<div class="block-content"></div>')
  })
  it("pages with Previous and Next, keeping the query", () => {
    const results = [{ href: "/post/a", typeLabel: "Post", dateLabel: "Oct 1, 2026", titleHtml: "A <mark>alt</mark>", excerptHtml: "" }]
    const html = render(docOf(["results-001"], b("results-001", "search_results")), context(search({ total: 30, totalLabel: "30 results", page: 2, totalPages: 3, results })))
    expect(html).toContain('<a href="/search?q=alt" class="page-link" rel="prev"><span aria-hidden="true">←</span> Previous</a>')
    expect(html).toContain('<a href="/search/page/3/?q=alt" class="page-link" rel="next">Next <span aria-hidden="true">→</span></a>')
    expect(html).toContain(" · Page 2")
    expect(html).not.toContain("search-result-excerpt")
    // Only <mark> survives, whatever reaches the block.
    const unsafe = render(docOf(["results-001"], b("results-001", "search_results")), context(search({ total: 1, totalLabel: "1 result", totalPages: 1, results: [{ ...results[0], titleHtml: '<img src=x onerror=alert(1)><mark>alt</mark>' }] })))
    expect(unsafe).toContain("&lt;img src=x onerror=alert(1)&gt;<mark>alt</mark>")
    expect(unsafe).not.toContain("<img src=x")
  })
})

describe("post_facts", () => {
  const body = docOf(["ph-000001", "ph-000002", "ph-000003"], heading("ph-000001", "One"), heading("ph-000002", "Two"), heading("ph-000003", "Three"))
  const routePost: SiteRoutePost = { ...item(post(9, "Shipping")), blocks: body }
  const facts = docOf(["facts-00001"], b("facts-00001", "post_facts", { fallback: true }))
  it("the published and updated days and the reading time", () => {
    const html = render(docOf(["facts-00001"], b("facts-00001", "post_facts")), context({ kind: "single", post: routePost }))
    expect(html).toContain('<dt class="section-title">Published</dt><dd><time dateTime="2026-10-18T12:00:00.000Z">October 18, 2026</time></dd>')
    expect(html).toContain('<dt class="section-title">Updated</dt>')
    expect(html).toContain('<dt class="section-title">Reading time</dt><dd>1 min</dd>')
  })
  it("with fallback, only beside no table of contents with entries and no category list", () => {
    const route: SiteRoute = { kind: "single", post: routePost }
    expect(render(facts, context(route, { pageShows: { tableOfContents: false, categoryList: false } }))).toContain("post-facts")
    expect(render(facts, context(route, { pageShows: { tableOfContents: true, categoryList: false } }))).not.toContain("post-facts")
    expect(render(facts, context(route, { pageShows: { tableOfContents: false, categoryList: true } }))).not.toContain("post-facts")
    // A table of contents block over a post with too few headings shows nothing: the facts stay.
    const short: SiteRoute = { kind: "single", post: { ...routePost, blocks: docOf(["ph-000001"], heading("ph-000001", "One")) } }
    expect(render(facts, context(short, { pageShows: { tableOfContents: true, categoryList: false } }))).toContain("post-facts")
  })
})

describe("the footer's last row", () => {
  it("the year and the site's title, and the credit", () => {
    const html = render(docOf(["copy-000001", "credit-0001"], b("copy-000001", "site_copyright"), b("credit-0001", "golive_credit")), context(undefined))
    expect(html).toContain('<span class="site-copyright">© 2026 Field Notes</span>')
    expect(html).toMatch(/<a href="https:\/\/github.com\/go-live-cms\/go-live-cms" class="golive-credit">Published with <svg[^>]*viewBox="0 0 66 67"[^>]*aria-hidden="true">/)
  })
})

describe("navigation (#498)", () => {
  const menu = { name: "Main", items: [{ id: 1, label: "Guides", url: "/category/guides", children: [{ id: 2, label: "Setup", url: "/page/setup", children: [] }] }, { id: 3, label: "About", url: "/page/about", children: [] }] }
  it("the header's phone menu: the button and the dialog, with Home, search and the switch, even with no menu", () => {
    const doc = docOf(["header-nav1"], b("header-nav1", "navigation", { location: "primary", overlay: "menu" }))
    const html = render(doc, context(undefined, { menusByLocation: { primary: menu }, currentPath: "/" }))
    expect(html).toContain('<button type="button" class="icon-btn menu-btn" aria-label="Open menu" aria-expanded="false" aria-controls="site-menu" data-site-menu-open="">')
    expect(html).toContain('<dialog id="site-menu" class="mobile-menu" aria-label="Menu" data-site-menu="">')
    expect(html).toContain('<a href="/" aria-current="page">Home</a>')
    expect(html).toContain('<ul class="mobile-submenu" role="list"><li><a href="/page/setup">Setup</a></li></ul>')
    expect(html).toContain('<label for="menu-q" class="sr-only">Search the blog</label>')
    expect(html).toContain('<legend class="section-title">Appearance</legend>')
    const empty = render(doc, context(undefined, { menusByLocation: { primary: null } }))
    expect(empty).not.toContain("site-nav")
    expect(empty).toContain("data-site-menu-open")
  })
  it("the footer's columns: a headed column per parent, the rest and the feed under Site, even with no menu", () => {
    const doc = docOf(["footer-nav1"], b("footer-nav1", "navigation", { location: "footer", layout: "columns" }))
    const html = render(doc, context(undefined, { menusByLocation: { footer: menu } }))
    expect(html).toContain('<h2 id="footer-col-0"><a href="/category/guides" class="footer-heading">Guides</a></h2><a href="/page/setup">Setup</a>')
    expect(html).toContain('<h2 id="footer-site">Site</h2><a href="/page/about">About</a><a href="/rss.xml">RSS feed</a>')
    expect(render(doc, context(undefined, { menusByLocation: { footer: null } }))).toContain('<h2 id="footer-site">Site</h2><a href="/rss.xml">RSS feed</a>')
    // A menu chosen by id that was deleted renders nothing, as in every layout.
    expect(render(docOf(["footer-nav1"], b("footer-nav1", "navigation", { menuId: 9, layout: "columns" })), context(undefined))).toBe('<div class="block-content"></div>')
  })
})

describe("the other new attrs", () => {
  const routePost: SiteRoutePost = {
    ...item(post(9, "Shipping", { description: "A dek." }), "/uploads/media/hero.jpg"),
    terms: [
      { id: 2, name: "Updates", slug: "updates", taxonomy_type_name: "category", taxonomy_label: "Categories", href: "/category/updates" },
      { id: 3, name: "Editor", slug: "editor", taxonomy_type_name: "tag", taxonomy_label: "Tags" },
    ] as never,
  }
  it("the icon search link and the popover switch", () => {
    const html = render(docOf(["search-0001", "switch-0001"], b("search-0001", "search", { variant: "icon" }), b("switch-0001", "color_scheme_switch", { variant: "popover" })), context(undefined))
    expect(html).toContain('<a href="/search" class="icon-btn" aria-label="Search">')
    expect(html).toContain('<button type="button" class="icon-btn" aria-label="Theme" aria-expanded="false" aria-controls="theme-menu" data-theme-menu-toggle="">')
    expect(html).toContain('<div id="theme-menu" class="theme-popover" role="group" aria-label="Theme" hidden=""><div class="theme-choices theme-choices--menu">')
  })
  it("the search field holds the search on the search page", () => {
    expect(render(docOf(["search-0001"], b("search-0001", "search")), context({ kind: "search", search: { query: "alt text" } }))).toContain('value="alt text"')
  })
  it("every taxonomy's terms, and the excerpt as the page's dek", () => {
    const html = render(docOf(["terms-00001", "dek-0000001"], b("terms-00001", "post_terms", { all: true }), b("dek-0000001", "post_excerpt")), context({ kind: "single", post: routePost }))
    expect(html).toContain('<dt class="section-title">Categories</dt><dd class="post-terms__term" data-slug="updates"><a class="chip" href="/category/updates">Updates</a></dd>')
    expect(html).toContain('<dt class="section-title">Tags</dt><dd class="chip post-terms__term" data-slug="editor">Editor</dd>')
    expect(html).toContain('<p class="dek">A dek.</p>')
  })
  it("a query of titles only, and the featured first post with the rest under More posts", () => {
    const links = docOf(["query-00001"], b("query-00001", "query", { layout: "links" }, ["items-00001"]), b("items-00001", "post_template", {}, ["title-00001"]), b("title-00001", "post_title"))
    const posts = list([item(post(1, "One"), "/uploads/one.jpg"), item(post(2, "Two"))])
    expect(render(links, context({ kind: "404" }, { queries: { "query-00001": posts } }))).toContain('<ul class="link-list"><li><a href="/post/one">One</a></li><li><a href="/post/two">Two</a></li></ul>')
    const feature = docOf(["query-00001"], b("query-00001", "query", { inherit: true, feature: true }, ["items-00001"]), b("items-00001", "post_template", {}, ["title-00001"]), b("title-00001", "post_title"))
    const html = render(feature, context({ kind: "home", list: posts }, { queries: { "query-00001": posts } }))
    expect(html).toMatch(/<article class="feature has-media">[\s\S]*<span class="eyebrow">Latest<\/span><h2 class="title feature-title"><a href="\/post\/one">One<\/a><\/h2>/)
    expect(html).toContain('<section aria-labelledby="more-posts"><h2 id="more-posts" class="section-title list-heading">More posts</h2><ul class="post-list">')
    // A later page has no featured post: every post is listed, under "Posts".
    const later = render(feature, context({ kind: "home", list: { ...posts, page: 2, totalPages: 2 } }, { queries: { "query-00001": { ...posts, page: 2, totalPages: 2 } } }))
    expect(later).not.toContain("feature")
    expect(later).toContain(">Posts</h2>")
  })
  it("the list end on one page of a term or an author", () => {
    const doc = docOf(["query-00001"], b("query-00001", "query", { inherit: true }, ["items-00001", "pager-00001"]), b("items-00001", "post_template", {}, ["title-00001"]), b("title-00001", "post_title"), b("pager-00001", "query_pagination", { end: true }))
    const posts = list([item(post(1, "One"))], { basePath: "/tag/editor" })
    const term = render(doc, context({ kind: "term", term: { name: "Editor", phrase: "tagged Editor" }, list: posts }, { queries: { "query-00001": posts } }))
    expect(term).toContain('<p class="meta list-end">That’s every post tagged Editor. <a href="/">Back to all posts</a></p>')
    const archive = render(doc, context({ kind: "archive", list: posts }, { queries: { "query-00001": posts } }))
    expect(archive).not.toContain("list-end")
  })
})
