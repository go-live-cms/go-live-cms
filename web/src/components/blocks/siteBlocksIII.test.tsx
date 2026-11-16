import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import type { AuthorProfile, Post } from "@gl-admin/lib/api/types"
import BlockRenderer from "../BlockRenderer"
import { siteBlockTitleIds } from "./utils/pageScope"
import type { SitePostItem, SitePostList, SiteRenderContext, SiteRoute, SiteRoutePost } from "./utils/siteContext"

// Site blocks III on the public page (#497, design theme-builder.md 4.1, 5.7): related posts,
// author cards, the table of contents and the colour scheme switch render from the
// SiteRenderContext only (never in a post's body), the table of contents links to exactly the
// ids post_content gives the post's headings, and the byline shows the reading time. Their
// markup is compared with the default theme's components in
// themes/default/siteBlocksMarkup.astro.test.ts.

type B = { id: string; type: string; version: 1; attrs: Record<string, unknown>; children?: string[] }
const b = (id: string, type: string, attrs: Record<string, unknown> = {}, children?: string[]): B => ({ id, type, version: 1, attrs, ...(children ? { children } : {}) })
const docOf = (order: string[], ...blocks: B[]): BlockDocV1 =>
  ({ doc_version: 1, blocks_order: order, blocks: Object.fromEntries(blocks.map((x) => [x.id, x])) }) as unknown as BlockDocV1
const heading = (id: string, text: string, level = 2) => b(id, "heading", { level, pm: { type: "heading", attrs: { level }, content: [{ type: "text", text }] } })
const para = (id: string, text: string) => b(id, "paragraph", { pm: { type: "paragraph", content: [{ type: "text", text }] } })

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
const item = (p: Post, image: string | null = "/uploads/media/a.jpg"): SitePostItem => ({ post: p, href: `/post/${p.slug}`, image })

// The post's body: four headings (a Heading 1 renders as an h2, #481), one of them named as the
// template's own heading, one whose slug is the table of contents' title id.
const body = docOf(
  ["ph-000001", "pp-000001", "ph-000002", "ph-000003", "ph-000004", "ph-000005"],
  heading("ph-000001", "Intro", 1),
  para("pp-000001", Array.from({ length: 660 }, (_, i) => `word${i}`).join(" ")),
  heading("ph-000002", "How it works"),
  heading("ph-000003", "The details", 3),
  heading("ph-000004", "Toc title"),
  heading("ph-000005", "Too deep", 4),
)
const authors: AuthorProfile[] = [
  { username: "ana", full_name: "Ana Costa", avatar: null, bio: "Writes the guides.", website: "" },
  { username: "luan", full_name: "", avatar: null, bio: "", website: "" },
] as unknown as AuthorProfile[]
const routePost: SiteRoutePost = { ...item(post(9, "Shipping collaboration")), blocks: body, authors }
const singleRoute: SiteRoute = { kind: "single", post: routePost }
const relatedList: SitePostList = { items: [item(post(1, "Roles explained")), item(post(2, "Alt text", { authors: [] , username: "luan" }), null)], page: 1, totalPages: 1, basePath: null }

function context(route: SiteRoute | undefined, overrides: Partial<SiteRenderContext> = {}): SiteRenderContext {
  return {
    inTemplate: true,
    kind: "template",
    site: { title: "GoLive Blog", tagline: "" },
    logo: null,
    menusByLocation: {},
    menusById: {},
    parts: {},
    dates: { language: "en-US", timeZone: "UTC", dateFormat: "month_day_year" },
    ...(route ? { route } : {}),
    queries: {},
    related: {},
    ...overrides,
  }
}

// The single template a converted default theme would ship (#498): a heading of its own, the
// table of contents in a group, the post, then the post's end.
const single = docOf(
  ["th-000001", "group-0001", "content-01", "authors-01", "related-01", "switch-001"],
  heading("th-000001", "Intro"),
  b("group-0001", "group", {}, ["toc-000001"]),
  b("toc-000001", "table_of_contents"),
  b("content-01", "post_content"),
  b("authors-01", "author_cards"),
  b("related-01", "related_posts"),
  b("switch-001", "color_scheme_switch"),
)

const render = (doc: BlockDocV1, site?: SiteRenderContext | null, props: Record<string, unknown> = {}) => renderToStaticMarkup(<BlockRenderer doc={doc} site={site} {...props} />)
const headingIds = (html: string) => [...html.matchAll(/<h[1-6] id="([^"]+)"/g)].map((m) => m[1])
const tocHrefs = (html: string) => [...(html.match(/<nav[^>]*class="toc-block"[\s\S]*?<\/nav>/)?.[0] ?? "").matchAll(/href="#([^"]+)"/g)].map((m) => m[1])

describe("site blocks III outside a template (#497, design 4.2)", () => {
  it("render nothing in a post's body, whatever the post holds", () => {
    const html = render(single)
    for (const cls of ["toc-block", "author-cards", "related-posts", "theme-choices", "prose"]) expect(html, cls).not.toContain(cls)
    // Their title ids aren't reserved in a post: its own headings keep the ids they always had.
    expect(html).toContain('id="intro"')
  })

  it("and nothing inside a post template (a list): they show the page's post", () => {
    const loop = docOf(
      ["query-0001"],
      b("query-0001", "query", {}, ["templ-0001"]),
      b("templ-0001", "post_template", {}, ["toc-000001", "authors-01", "related-01", "title-0001"]),
      b("toc-000001", "table_of_contents"),
      b("authors-01", "author_cards"),
      b("related-01", "related_posts"),
      b("title-0001", "post_title"),
    )
    const html = render(loop, context(singleRoute, { queries: { "query-0001": relatedList }, related: { "related-01": relatedList } }))
    expect(html).toContain("post-item-title")
    for (const cls of ["toc-block", "author-cards", "related-posts"]) expect(html, cls).not.toContain(cls)
  })
})

describe("table_of_contents (#497)", () => {
  const html = render(single, context(singleRoute), { reservedIds: ["content"] })

  it("links to exactly the ids post_content gives the post's headings", () => {
    // The template's "Intro" took "intro", so the post's is "intro-2"; "Toc title" can't take the
    // TOC's own title id; the H4 isn't listed.
    expect(tocHrefs(html)).toEqual(["intro-2", "how-it-works", "the-details", "toc-title-2"])
    const ids = headingIds(html)
    for (const href of tocHrefs(html)) expect(ids, href).toContain(href)
    // Every id on the page once: the template's headings, the blocks' titles, the post's headings.
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("lists a Heading 1 as the h2 it renders as (#481), with its H3s nested", () => {
    expect(html).toContain('<h2 id="intro-2">Intro</h2>')
    expect(html).toMatch(/<li><a href="#how-it-works">How it works<\/a><ol class="toc toc--nested"><li><a href="#the-details">The details<\/a><\/li><\/ol><\/li>/)
    expect(html).toContain('<nav class="toc-block" aria-labelledby="toc-title"><h2 id="toc-title" class="section-title">On this page</h2><ol class="toc">')
  })

  it("agrees with post_content when it sits in a part (a sidebar), where the scope is the part's", () => {
    const sidebar = docOf(["toc-000002"], b("toc-000002", "table_of_contents"))
    const withPart = docOf(["th-000001", "part-00001", "content-01"], heading("th-000001", "Intro"), b("part-00001", "template_part", { slug: "sidebar" }), b("content-01", "post_content"))
    const page = render(withPart, context(singleRoute, { parts: { sidebar } }))
    expect(page).toContain('<div id="b-part-00001" class="template-part template-part--sidebar">')
    const ids = headingIds(page)
    expect(tocHrefs(page)).toEqual(["intro-2", "how-it-works", "the-details", "toc-title-2"])
    for (const href of tocHrefs(page)) expect(ids, href).toContain(href)
  })

  it("shows nothing for a post with fewer than three headings, or without a post", () => {
    const short: SiteRoutePost = { ...routePost, blocks: docOf(["h1-0000001", "h2-0000001"], heading("h1-0000001", "One"), heading("h2-0000001", "Two")) }
    expect(render(single, context({ kind: "single", post: short }))).not.toContain("toc-block")
    expect(render(single, context({ kind: "archive" }))).not.toContain("toc-block")
  })
})

describe("the blocks' title ids (#497)", () => {
  it("are the theme's, a second block of a type in one doc getting -2, and no heading takes them", () => {
    const two = docOf(["toc-000001", "toc-000002", "th-000001"], b("toc-000001", "table_of_contents"), b("toc-000002", "table_of_contents"), heading("th-000001", "Toc title"))
    expect([...siteBlockTitleIds(two).values()]).toEqual(["toc-title", "toc-title-2"])
    const html = render(two, context(singleRoute))
    expect(html).toContain('aria-labelledby="toc-title"')
    expect(html).toContain('aria-labelledby="toc-title-2"')
    expect(headingIds(html)).toContain("toc-title-3")
    const ids = headingIds(html)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("author_cards (#497)", () => {
  it("one card per credited author, in byline order, each linking to their page, with a bio when they have one", () => {
    const html = render(docOf(["authors-01"], b("authors-01", "author_cards")), context(singleRoute))
    expect(html).toContain('<section id="b-authors-01" class="author-cards" aria-labelledby="written-by"><h2 id="written-by" class="section-title">Written by</h2>')
    expect(html).toContain('<h3><a href="/author/ana">Ana Costa</a></h3><p class="author-bio">Writes the guides.</p>')
    // No full name: the username; no bio: no paragraph.
    expect(html).toContain('<h3><a href="/author/luan">luan</a></h3></div>')
    expect(html.indexOf("/author/ana")).toBeLessThan(html.indexOf("/author/luan"))
    expect(html).toMatch(/<span class="avatar" aria-hidden="true" style="width:56px;height:56px;font-size:20px;background:#[0-9a-f]{6}">A<\/span>/)
  })

  it("nothing for a post that credits nobody", () => {
    const html = render(docOf(["authors-01"], b("authors-01", "author_cards")), context({ kind: "single", post: { ...routePost, authors: [] } }))
    expect(html).not.toContain("author-cards")
  })
})

describe("related_posts (#497)", () => {
  it("cards for the posts the context read for it: image, title, the byline's names and the short date", () => {
    const html = render(docOf(["related-01"], b("related-01", "related_posts")), context(singleRoute, { related: { "related-01": relatedList } }))
    expect(html).toContain('<section id="b-related-01" class="related-posts" aria-labelledby="more-to-read"><h2 id="more-to-read" class="section-title">More to read</h2><div class="card-grid">')
    expect(html).toContain('<article class="card"><a href="/post/roles-explained" tabindex="-1" aria-hidden="true"><img class="media" src="/uploads/media/a.jpg" alt="" loading="lazy" decoding="async"/></a><h3 class="card-title"><a href="/post/roles-explained">Roles explained</a></h3><span class="meta">Ana Costa · Oct 18, 2026</span></article>')
    // No image: no media link; no byline: the owner's name.
    expect(html).toContain('<article class="card"><h3 class="card-title"><a href="/post/alt-text">Alt text</a></h3><span class="meta">luan · Oct 18, 2026</span></article>')
  })

  it("a part's block finds its posts under the part's key", () => {
    const part = docOf(["related-01"], b("related-01", "related_posts"))
    const page = docOf(["part-00001"], b("part-00001", "template_part", { slug: "post-end" }))
    expect(render(page, context(singleRoute, { parts: { "post-end": part }, related: { "part:post-end:related-01": relatedList } }))).toContain("Roles explained")
    expect(render(page, context(singleRoute, { parts: { "post-end": part }, related: { "related-01": relatedList } }))).not.toContain("related-posts")
  })

  it("nothing when its read failed, was over the page's four, or found no posts", () => {
    const doc = docOf(["related-01", "para-after"], b("related-01", "related_posts"), para("para-after", "The rest of the page"))
    const cases: Record<string, SitePostList | null>[] = [{}, { "related-01": null }, { "related-01": { ...relatedList, items: [] } }]
    for (const related of cases) {
      const html = render(doc, context(singleRoute, { related }))
      expect(html).not.toContain("related-posts")
      expect(html).toContain("The rest of the page")
    }
  })
})

describe("color_scheme_switch (#497)", () => {
  it("ThemeSwitch's buttons in a labelled group, with no script and no inline handler", () => {
    const html = render(docOf(["switch-001"], b("switch-001", "color_scheme_switch")), context(undefined))
    expect(html).toBe(
      '<div class="block-content"><div id="b-switch-001" class="color-scheme-switch" role="group" aria-label="Theme"><div class="theme-choices theme-choices--segmented">' +
        '<button type="button" class="theme-choice" data-theme-choice="light" aria-pressed="false">Light</button>' +
        '<button type="button" class="theme-choice" data-theme-choice="dark" aria-pressed="false">Dark</button>' +
        '<button type="button" class="theme-choice" data-theme-choice="system" aria-pressed="false">System</button>' +
        "</div></div></div>",
    )
    expect(html).not.toMatch(/<script|\son[a-z]+=/i)
  })

  it("the menu look", () => {
    expect(render(docOf(["switch-001"], b("switch-001", "color_scheme_switch", { variant: "menu" })), context(undefined))).toContain('class="theme-choices theme-choices--menu"')
  })
})

describe("post_byline's reading time (#497)", () => {
  it("adds “· N min read” after the names, from the published body, only when asked", () => {
    const withTime = render(docOf(["byline-001"], b("byline-001", "post_byline", { readingTime: true })), context(singleRoute))
    expect(withTime).toContain('<a href="/author/ana">Ana Costa</a> and <a href="/author/luan">luan</a> · 3 min read</span>')
    const without = render(docOf(["byline-001"], b("byline-001", "post_byline")), context(singleRoute))
    expect(without).not.toContain("min read")
  })

  it("in a list, from the row's published blocks; nothing for a post without text", () => {
    const rows: SitePostList = { items: [item(post(1, "Long", { published_blocks: body } as Partial<Post>)), item(post(2, "Empty"))], page: 1, totalPages: 1, basePath: null }
    const loop = docOf(["query-0001"], b("query-0001", "query", {}, ["templ-0001"]), b("templ-0001", "post_template", {}, ["byline-001"]), b("byline-001", "post_byline", { readingTime: true }))
    const html = render(loop, context(singleRoute, { queries: { "query-0001": rows } }))
    expect(html.match(/min read/g)).toHaveLength(1)
  })
})
