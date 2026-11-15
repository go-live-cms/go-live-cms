import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import type { Post } from "@gl-admin/lib/api/types"
import BlockRenderer from "../BlockRenderer"
import { pageLinks, pagePath, pageWindow } from "../../lib/pagination"
import { queryKey, type SitePostItem, type SitePostList, type SiteRenderContext, type SiteRoute } from "./utils/siteContext"
import { excerptWords, postDateOf, queryTitleText } from "./utils/postBlocks"

// Site blocks II on the public page (#489; the blocks canvas's "Published site blocks" and the
// default theme canvas's "Site blocks" boards): the query loop and the post blocks render the
// default theme's own list and post markup from the SiteRenderContext, the pager's URLs are
// #349's, and a query whose posts aren't in the context (failed, or over the four) renders
// nothing while the page does.

type B = { id: string; type: string; version: 1; attrs: Record<string, unknown>; children?: string[] }
const b = (id: string, type: string, attrs: Record<string, unknown> = {}, children?: string[]): B => ({ id, type, version: 1, attrs, ...(children ? { children } : {}) })
const docOf = (order: string[], ...blocks: B[]): BlockDocV1 =>
  ({ doc_version: 1, blocks_order: order, blocks: Object.fromEntries(blocks.map((x) => [x.id, x])) }) as unknown as BlockDocV1

function post(id: number, title: string, extra: Partial<Post> = {}): Post {
  return {
    id,
    title,
    description: `About ${title}, in more words than the list shows`,
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
const item = (p: Post, image: string | null = "/uploads/media/a.jpg"): SitePostItem => ({ post: p, href: `/post/${p.slug}`, image })
const items = [item(post(1, "Roles explained")), item(post(2, "Alt text"), null)]

const archiveList: SitePostList = { items, page: 2, totalPages: 5, basePath: "/category/guides" }

// The archive template of the default theme canvas's "Site blocks" board.
const archiveTemplate = docOf(
  ["qtitle-001", "tdesc-0001", "query-0001", "para-after"],
  b("qtitle-001", "query_title"),
  b("tdesc-0001", "term_description"),
  b("query-0001", "query", { inherit: true }, ["templ-0001", "pager-0001", "empty-0001"]),
  b("templ-0001", "post_template", {}, ["terms-0001", "title-0001", "excer-0001", "byline-001", "date-00001", "image-0001"]),
  b("terms-0001", "post_terms"),
  b("title-0001", "post_title"),
  b("excer-0001", "post_excerpt", { length: 5 }),
  b("byline-001", "post_byline"),
  b("date-00001", "post_date", { format: "short" }),
  b("image-0001", "post_featured_image", { link: true }),
  b("pager-0001", "query_pagination"),
  b("empty-0001", "query_no_results", {}, ["para-empty"]),
  b("para-empty", "paragraph", { text: "Nothing in Guides yet." }),
  b("para-after", "paragraph", { text: "The rest of the page" }),
)

function context(route: SiteRoute, queries: SiteRenderContext["queries"] = {}, overrides: Partial<SiteRenderContext> = {}): SiteRenderContext {
  return {
    inTemplate: true,
    kind: "template",
    site: { title: "GoLive Blog", tagline: "" },
    logo: null,
    menusByLocation: {},
    menusById: {},
    parts: {},
    dates: { language: "en-US", timeZone: "UTC", dateFormat: "month_day_year" },
    route,
    queries,
    ...overrides,
  }
}

const archiveRoute: SiteRoute = { kind: "term", term: { name: "Guides", description: "How to get the most out of GoLive." }, list: archiveList }
const render = (doc: BlockDocV1, site?: SiteRenderContext | null) => renderToStaticMarkup(<BlockRenderer doc={doc} site={site} />)
const hrefs = (html: string, cls: string) => [...html.matchAll(new RegExp(`<a href="([^"]*)" class="${cls}`, "g"))].map((m) => m[1])

describe("the query loop (#489)", () => {
  it("renders the theme's list markup for the page's own list", () => {
    const html = render(archiveTemplate, context(archiveRoute, { "query-0001": archiveList }))
    expect(html).toContain('<h1 id="b-qtitle-001" class="title">Guides</h1>')
    expect(html).toContain('<p id="b-tdesc-0001" class="dek">How to get the most out of GoLive.</p>')
    expect(html).toContain('<div id="b-query-0001" class="query-loop"><ul class="post-list">')
    // One row per post; the one with an image has the media slot after its body.
    expect(html).toContain('<li class="post-item has-media"><div class="post-item-body">')
    expect(html).toContain('<h3 class="post-item-title"><a href="/post/roles-explained">Roles explained</a></h3>')
    expect(html).toContain('<p class="post-item-excerpt">About Roles explained, in more…</p>')
    expect(html).toContain('<span><a href="/author/ana">Ana Costa</a></span>')
    expect(html).toContain('<time dateTime="2026-10-18T12:00:00.000Z">Oct 18, 2026</time>')
    expect(html).toContain('<a href="/post/roles-explained" tabindex="-1" aria-hidden="true" class="post-item-media"><img class="media" src="/uploads/media/a.jpg" alt="" loading="lazy" decoding="async"/></a></li>')
    expect(html).toContain('<li class="post-item"><div class="post-item-body">')
    // A list row carries no terms yet, so the eyebrow shows nothing there.
    expect(html).not.toContain("eyebrow")
    // "No results" only for an empty list; the page goes on after the loop.
    expect(html).not.toContain("query-no-results")
    expect(html).toContain("The rest of the page")
  })

  it("its pager's URLs are #349's: page 1 is the list's own URL, page N <base>/page/N/", () => {
    const html = render(archiveTemplate, context(archiveRoute, { "query-0001": archiveList }))
    const links = pageLinks("/category/guides", 2, 5)
    expect(links).toEqual({ newer: "/category/guides", older: "/category/guides/page/3/" })
    expect(html).toContain(`<a href="${links.newer}" class="page-link" rel="prev">`)
    expect(html).toContain(`<a href="${links.older}" class="page-link" rel="next">`)
    const numbers = pageWindow(2, 5).filter((slot): slot is number => slot !== "gap")
    expect(hrefs(html, "page-link page-num")).toEqual(numbers.map((n) => pagePath("/category/guides", n)))
    expect(html).toContain('<a href="/category/guides/page/2/" class="page-link page-num" aria-label="Page 2" aria-current="page">2</a>')
    expect(html).toContain('<span class="page-status">Page 2 of 5</span>')
    expect(html).toContain('<span class="page-link page-num" aria-hidden="true">…</span>')
  })

  it("a search list's pager keeps its query", () => {
    const search: SitePostList = { items, page: 1, totalPages: 2, basePath: "/search", pageQuery: "?q=alt" }
    const html = render(archiveTemplate, context({ kind: "search", search: { query: "alt" }, list: search }, { "query-0001": search }))
    expect(html).toContain('<h1 id="b-qtitle-001" class="title">Search results for “alt”</h1>')
    expect(hrefs(html, "page-link page-num")).toEqual(["/search?q=alt", "/search/page/2/?q=alt"])
    expect(html).toContain('<span class="page-link is-disabled" aria-hidden="true">← Newer</span>')
  })

  it("a query of chosen posts has no pager, whatever its list says (two pagers can't share /page/N/)", () => {
    const chosen = docOf(["query-0001"], b("query-0001", "query", { perPage: 2 }, ["templ-0001", "pager-0001"]), b("templ-0001", "post_template", {}, ["title-0001"]), b("title-0001", "post_title"), b("pager-0001", "query_pagination"))
    const html = render(chosen, context({ kind: "home" }, { "query-0001": { items, page: 1, totalPages: 9, basePath: null } }))
    expect(html).toContain("post-item-title")
    expect(html).not.toContain("pagination")
  })

  it("shows its no results blocks for an empty list, and no post template", () => {
    const empty: SitePostList = { items: [], page: 1, totalPages: 0, basePath: "/category/guides" }
    const html = render(archiveTemplate, context({ ...archiveRoute, list: empty }, { "query-0001": empty }))
    expect(html).toContain('<div class="query-no-results"><p>Nothing in Guides yet.</p></div>')
    expect(html).not.toContain("post-list")
    expect(html).not.toContain("pagination")
  })

  it("renders nothing when its posts aren't in the context (it failed, or is over the page's four); the page still renders", () => {
    for (const queries of [{}, { "query-0001": null }] as Record<string, SitePostList | null>[]) {
      const html = render(archiveTemplate, context(archiveRoute, queries))
      expect(html).not.toContain("query-loop")
      expect(html).not.toContain("Nothing in Guides yet.")
      expect(html).toContain("<h1")
      expect(html).toContain("The rest of the page")
    }
  })

  it("a query in a part finds its posts under the part's key", () => {
    const part = docOf(["query-0001"], b("query-0001", "query", {}, ["templ-0001"]), b("templ-0001", "post_template", {}, ["title-0001"]), b("title-0001", "post_title"))
    const template = docOf(["part-00001"], b("part-00001", "template_part", { slug: "sidebar" }))
    const html = render(template, context({ kind: "single" }, { [queryKey("sidebar", "query-0001")]: { items, page: 1, totalPages: 1, basePath: null } }, { parts: { sidebar: part } }))
    expect(html).toContain('class="template-part template-part--sidebar"')
    expect(html).toContain("Roles explained")
    // The template's own key for the same id is a different query.
    expect(render(template, context({ kind: "single" }, { "query-0001": { items, page: 1, totalPages: 1, basePath: null } }, { parts: { sidebar: part } }))).not.toContain("Roles explained")
  })

  it("renders nothing outside a template: in a post the whole loop is inert", () => {
    expect(render(archiveTemplate)).toBe('<div class="block-content"><p id="b-para-after">The rest of the page</p></div>')
  })
})

describe("the post blocks on the page's own post (#489)", () => {
  const body = docOf(
    ["body-head1", "body-site1", "body-para1"],
    b("body-head1", "heading", { level: 2, text: "Notes" }),
    // A post's own site block stays inert inside the template (site={null}).
    b("body-site1", "site_title"),
    b("body-para1", "paragraph", { text: "The post's own words." }),
  )
  const single: SiteRoute = {
    kind: "single",
    post: {
      ...item(post(7, "Shipping collaboration", { changed_at: "2026-11-02T09:00:00Z" }), "/uploads/media/hero.jpg"),
      blocks: body,
      terms: [
        { id: 3, name: "Product updates", slug: "product-updates", taxonomy_type_name: "category", href: "/category/product-updates" },
        { id: 4, name: "Editor", slug: "editor", taxonomy_type_name: "tag", taxonomy_label: "Tags", href: "/tag/editor" },
      ] as never,
      authors: [
        { username: "luan", full_name: "Luan", avatar: null } as never,
        { username: "ana", full_name: "Ana Costa", avatar: null } as never,
      ],
      adjacent: { previous: item(post(6, "Analytics")), next: null, archiveHref: "/post", archiveLabel: "All posts" },
    },
  }
  const template = docOf(
    ["terms-0001", "title-0001", "byline-001", "date-00001", "date-00002", "image-0001", "content-01", "tags-00001", "pnav-00001", "head-00001"],
    b("terms-0001", "post_terms"),
    b("title-0001", "post_title"),
    b("byline-001", "post_byline", { avatars: false }),
    b("date-00001", "post_date"),
    b("date-00002", "post_date", { which: "modified" }),
    b("image-0001", "post_featured_image", { aspect: "16-9" }),
    b("content-01", "post_content"),
    b("tags-00001", "post_terms", { taxonomy: "tag" }),
    b("pnav-00001", "post_navigation"),
    b("head-00001", "heading", { level: 2, text: "Notes" }),
  )

  it("render the post header, its body and its end with the theme's markup", () => {
    const html = render(template, context(single))
    expect(html).toContain('<a id="b-terms-0001" class="eyebrow" href="/category/product-updates">Product updates</a>')
    expect(html).toContain('<h1 id="b-title-0001" class="title">Shipping collaboration</h1>')
    expect(html).toContain('<div id="b-byline-001" class="byline meta"><span>By <a href="/author/luan">Luan</a> and <a href="/author/ana">Ana Costa</a></span></div>')
    expect(html).toContain('<p id="b-date-00001" class="meta post-date"><time dateTime="2026-10-18T12:00:00.000Z">October 18, 2026</time></p>')
    expect(html).toContain('<p id="b-date-00002" class="meta post-date">Updated <time dateTime="2026-11-02T09:00:00.000Z">November 2, 2026</time></p>')
    expect(html).toContain('<figure id="b-image-0001" class="post-featured"><img class="is-aspect-16-9" src="/uploads/media/hero.jpg" alt="" decoding="async"/></figure>')
    expect(html).toContain('<dt class="section-title">Tags</dt><dd class="post-terms__term" data-slug="editor"><a class="chip" href="/tag/editor">Editor</a></dd>')
    expect(html).toContain('<a href="/post/analytics" class="post-nav-link" rel="prev"><span>← Older post</span>Analytics</a>')
    expect(html).toContain('<a href="/post" class="post-nav-link is-next"><span>Back to</span>All posts →</a>')
  })

  it("post_content renders the published body with its own anchors, its site blocks inert, its heading ids unique on the page", () => {
    const html = render(template, context(single))
    expect(html).toContain('<div id="b-content-01" class="prose"><div class="block-content">')
    expect(html).toContain("The post&#x27;s own words.")
    expect(html).toContain('id="b-body-para1"')
    // The body's site title renders nothing; the template has no site title of its own here.
    expect(html).not.toContain("site-title")
    // Two "Notes" headings on one page, two ids.
    const ids = [...html.matchAll(/<h2[^>]* id="([^"]+)"/g)].map((m) => m[1])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("in a list, post_content renders nothing and post_navigation neither", () => {
    const loop = docOf(["query-0001"], b("query-0001", "query", {}, ["templ-0001"]), b("templ-0001", "post_template", {}, ["content-01", "pnav-00001", "title-0001"]), b("content-01", "post_content"), b("pnav-00001", "post_navigation"), b("title-0001", "post_title"))
    const html = render(loop, context(single, { "query-0001": { items, page: 1, totalPages: 1, basePath: null } }))
    expect(html).not.toContain("prose")
    expect(html).not.toContain("post-nav")
    expect(html).toContain('<h3 class="post-item-title"><a href="/post/alt-text">Alt text</a></h3>')
  })

  it("a route without a post renders none of them", () => {
    expect(render(template, context({ kind: "archive" }))).toBe('<div class="block-content"><h2 id="notes"><span id="b-head-00001" class="gl-block-anchor"></span>Notes</h2></div>')
  })
})

describe("what the post blocks read (#489)", () => {
  it("query_title names what the page lists", () => {
    expect(queryTitleText({ kind: "term", term: { name: "Guides" } })).toBe("Guides")
    expect(queryTitleText({ kind: "author", author: { name: "Ana Costa" } })).toBe("Posts by Ana Costa")
    expect(queryTitleText({ kind: "search", search: { query: "alt text" } })).toBe("Search results for “alt text”")
    expect(queryTitleText({ kind: "archive", postType: { name: "product", label: "Products" } })).toBe("Products")
    expect(queryTitleText({ kind: "single" })).toBeNull()
    expect(queryTitleText(undefined)).toBeNull()
  })

  it("an excerpt is cut at its words, from the excerpt or the first paragraph", () => {
    expect(excerptWords(post(1, "x", { description: "one two three four" }), 3)).toBe("one two three…")
    expect(excerptWords(post(1, "x", { description: "one two" }), 3)).toBe("one two")
    const firstParagraph = { doc_version: 1, blocks_order: ["p1"], blocks: { p1: { id: "p1", type: "paragraph", version: 1, attrs: { text: "From the body itself" } } } }
    expect(excerptWords(post(1, "x", { description: "", published_blocks: firstParagraph as never }), 2)).toBe("From the…")
  })

  it("the modified date is the published one for a post never changed since", () => {
    expect(postDateOf(post(1, "x", { changed_at: "0001-01-01T00:00:00Z" }), "modified")!.toISOString()).toBe("2026-10-18T12:00:00.000Z")
    expect(postDateOf(post(1, "x"), "modified")!.toISOString()).toBe("2026-11-02T09:00:00.000Z")
    expect(postDateOf(post(1, "x", { created_at: "nonsense" }), "published")).toBeNull()
  })
})
