import React from "react"
import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import type { Post } from "@gl-admin/lib/api/types"
import BlockRenderer from "../BlockRenderer"
import { PostCommentsSection } from "../comments/PostCommentsSection"
import { commentsView, COMMENTS_SCRIPT_SRC, DEFAULT_COMMENTS_SETTINGS, type PostCommentsData } from "@/lib/postComments"
import type { SiteComments, SiteRenderContext } from "./utils/siteContext"
import type { DateSettings } from "@/lib/siteDates"

// The comments site block on the public page (#500, docs/design/reader-comments.md 11.1): it
// renders core's PostCommentsSection from the SiteRenderContext, the same markup on the same
// inputs as the code layout's PostComments, and nothing in a post's body, a part, a query, or
// without comments. The whole-page parity with the default theme's code layouts is
// themes/default/theme.astro.test.ts ("block templates").

type B = { id: string; type: string; version: 1; attrs: Record<string, unknown>; children?: string[] }
const b = (id: string, type: string, attrs: Record<string, unknown> = {}, children?: string[]): B => ({ id, type, version: 1, attrs, ...(children ? { children } : {}) })
const docOf = (order: string[], ...blocks: B[]): BlockDocV1 =>
  ({ doc_version: 1, blocks_order: order, blocks: Object.fromEntries(blocks.map((x) => [x.id, x])) }) as unknown as BlockDocV1

const reader = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  parent_id: null,
  root_id: null,
  name: `Reader ${id}`,
  badge: null,
  avatar: null,
  body: `Comment ${id}`,
  created_at: "2026-11-12T09:30:00Z",
  edited: false,
  removed: false,
  replying_to: null,
  ...extra,
})
const data = {
  discussion: { state: "open", closes_at: null, count: 3 },
  threads: [
    { comment: reader(1, { name: "Kenji", body: "<script>alert(1)</script> see https://example.org" }), replies: [reader(2, { parent_id: 1, root_id: 1, name: "Ana", badge: "author" })], reply_count: 1 },
    { comment: reader(3), replies: [], reply_count: 0 },
  ],
  pagination: { page: 1, per_page: 30, total: 2, total_pages: 1 },
} as unknown as PostCommentsData

const URL_OF_PAGE = "https://blog.example/post/hello?comments=1&replyto=2"
const NOW = "2026-11-20T10:00:00.000Z"
const comments: SiteComments = { data, postId: 42, url: URL_OF_PAGE, now: NOW, settings: DEFAULT_COMMENTS_SETTINGS }
const dates: DateSettings = { language: "en-US", timeZone: "UTC", dateFormat: "month_day_year" }

function context(overrides: Partial<SiteRenderContext> = {}): SiteRenderContext {
  return {
    inTemplate: true,
    kind: "template",
    site: { title: "GoLive Blog", tagline: "" },
    logo: null,
    menusByLocation: {},
    menusById: {},
    parts: {},
    dates,
    route: { kind: "single", post: { post: { id: 42, title: "Hello" } as unknown as Post, href: "/post/hello", image: null } },
    comments,
    ...overrides,
  }
}

const render = (doc: BlockDocV1, site: SiteRenderContext | null | undefined) => renderToStaticMarkup(<BlockRenderer doc={doc} site={site ?? null} anchors={false} />)
// What PostComments.astro renders for the same post, URL, clock and settings (its `view`).
const codeLayout = (title?: string) => {
  const url = new URL(URL_OF_PAGE)
  const view = commentsView(data, 42, { path: url.pathname, url, now: new Date(NOW) }, DEFAULT_COMMENTS_SETTINGS, dates, title)!
  return renderToStaticMarkup(<PostCommentsSection view={view} script={COMMENTS_SCRIPT_SRC} />)
}

describe("the comments block (#500)", () => {
  it("renders the code layout's section on the same post, with the script once", () => {
    const html = render(docOf(["comments-01"], b("comments-01", "comments")), context())
    expect(html).toBe(`<div class="block-content">${codeLayout()}</div>`)
    expect(html.match(/<script src="\/gl-comments.js" defer=""><\/script>/g)).toHaveLength(1)
    // The page's own URL: Reply links to it, and the form replies to the ?replyto comment (#2).
    expect(html).toContain('href="/post/hello?replyto=1#comment-form"')
    expect(html).toContain('name="parent_id" value="2"')
  })

  it("its title heads the section, the count after it (16.1)", () => {
    const html = render(docOf(["comments-01"], b("comments-01", "comments", { title: "Responses" })), context())
    expect(html).toBe(`<div class="block-content">${codeLayout("Responses")}</div>`)
    expect(html).toContain('<h2 class="comments-title" id="comments-title">Responses <span class="comments-count">3</span></h2>')
  })

  it("comment text is text: markup is escaped, links are nofollow ugc", () => {
    const html = render(docOf(["comments-01"], b("comments-01", "comments")), context())
    expect(html).not.toContain("<script>alert")
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(html).toContain('<a href="https://example.org" rel="nofollow ugc noopener">https://example.org</a>')
  })

  it("renders nothing in a post's body, a part, a query, or without comments", () => {
    const doc = docOf(["comments-01", "para-00001"], b("comments-01", "comments"), b("para-00001", "paragraph", { pm: { type: "paragraph", content: [{ type: "text", text: "after" }] } }))
    const none = (html: string) => {
      expect(html).toContain("after")
      expect(html).not.toMatch(/comments|gl-comments/)
    }
    // A post's body: no site context (design 4.2).
    none(render(doc, null))
    // Comments off, closed with none, or a failed read: the collector leaves them out.
    none(render(doc, context({ comments: null })))
    none(render(doc, context({ comments: undefined })))
    // In a part (the store refuses it there; a kept-invalid part renders nothing either).
    none(render(doc, context({ kind: "part", partSlug: "footer" })))
    // In a query's post template or its no results.
    const query = docOf(
      ["query-0001"],
      b("query-0001", "query", {}, ["templ-0001", "empty-0001"]),
      b("templ-0001", "post_template", {}, ["comments-01"]),
      b("empty-0001", "query_no_results", {}, ["comments-02"]),
      b("comments-01", "comments"),
      b("comments-02", "comments"),
    )
    const listed = render(query, context({ queries: { "query-0001": { items: [], page: 1, totalPages: 0, basePath: null } } }))
    expect(listed).not.toMatch(/class="comments|gl-comments/)
  })

  it("never inserts raw HTML (6.3): its sources have no set:html or dangerouslySetInnerHTML", () => {
    for (const file of ["./utils/commentsBlock.tsx", "./comments/index.ts"]) {
      expect(readFileSync(new URL(file, import.meta.url), "utf8"), file).not.toMatch(/set:html|dangerouslySetInnerHTML/)
    }
  })
})
