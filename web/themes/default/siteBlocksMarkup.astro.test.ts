// Site blocks III (#497, design theme-builder.md 4.1, 5.7): each block renders the markup of the
// default theme component it replaces, so converting the theme to block templates (#498) changes
// nothing a reader or the theme's CSS sees. The components are rendered with Astro's Container
// API, the blocks with React, both from the same data, and compared element by element (the
// block's own `b-<id>` anchor aside: every top-level block carries one, #356).
import { experimental_AstroContainer as AstroContainer } from "astro/container"
import { JSDOM } from "jsdom"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import type { AuthorProfile, Post } from "@gl-admin/lib/api/types"
import BlockRenderer from "@/components/BlockRenderer"
import { headingAnchors, tableOfContents } from "@/components/blocks/utils/headingAnchors"
import type { SitePostItem, SiteRenderContext, SiteRoutePost } from "@/components/blocks/utils/siteContext"
import { THEME_ELEMENT_IDS } from "./lib/posts"

vi.mock("@/lib/siteSettings", () => ({
  getSiteSettings: async () => ({ title: "GoLive Blog", tagline: "", postsPerPage: 10, urlStructure: "slug", language: "en-US", timeZone: "UTC", dateFormat: "month_day_year" }),
}))

const RelatedPosts = (await import("./components/RelatedPosts.astro")).default
const AuthorCards = (await import("./components/AuthorCards.astro")).default
const TableOfContents = (await import("./components/TableOfContents.astro")).default
const ThemeSwitch = (await import("./components/ThemeSwitch.astro")).default

let container: AstroContainer
beforeEach(async () => {
  container = await AstroContainer.create()
})

/**
 * The markup as a canonical string: elements with their attributes sorted, and text with its
 * runs of whitespace as one space, trimmed where it starts or ends an element (Astro and React
 * lay out the same tree with different line breaks, which a browser renders alike). Text between
 * two elements (" and " between names) is kept exactly. Astro's dev-only
 * `data-astro-source-*` attributes are left out.
 */
function canonical(html: string): string {
  const { document, Node } = new JSDOM(`<body>${html}</body>`).window
  const walk = (node: ChildNode): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      let text = (node.textContent ?? "").replace(/\s+/g, " ")
      if (!node.previousSibling) text = text.trimStart()
      if (!node.nextSibling) text = text.trimEnd()
      return text === "" || text === " " ? "" : JSON.stringify(text)
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return ""
    const el = node as Element
    const attrs = [...el.attributes]
      .filter((a) => !a.name.startsWith("data-astro-source"))
      .map((a) => `${a.name}=${JSON.stringify(a.value)}`)
      .sort()
    return `<${el.tagName.toLowerCase()}${attrs.length ? " " + attrs.join(" ") : ""}>${[...el.childNodes].map(walk).join("")}</${el.tagName.toLowerCase()}>`
  }
  return [...document.body.childNodes].map(walk).join("")
}

/** The one top-level block's element, without its `b-<id>` anchor. */
function blockElement(html: string): string {
  const { document } = new JSDOM(`<body>${html}</body>`).window
  const el = document.querySelector(".block-content > *")
  expect(el, html).not.toBeNull()
  el!.removeAttribute("id")
  return el!.outerHTML
}

type B = { id: string; type: string; version: 1; attrs: Record<string, unknown>; children?: string[] }
const b = (id: string, type: string, attrs: Record<string, unknown> = {}, children?: string[]): B => ({ id, type, version: 1, attrs, ...(children ? { children } : {}) })
const docOf = (order: string[], ...blocks: B[]): BlockDocV1 =>
  ({ doc_version: 1, blocks_order: order, blocks: Object.fromEntries(blocks.map((x) => [x.id, x])) }) as unknown as BlockDocV1
const heading = (id: string, text: string, level = 2) => b(id, "heading", { level, pm: { type: "heading", attrs: { level }, content: [{ type: "text", text }] } })

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
    changed_at: "2026-10-18T12:00:00Z",
    authors: [
      { id: 1, username: "ana", full_name: "Ana Costa", avatar: null },
      { id: 2, username: "luan", full_name: "Luan", avatar: null },
    ],
    ...extra,
  } as unknown as Post
}
const item = (p: Post, image: string | null): SitePostItem => ({ post: p, href: `/post/${p.slug}`, image })

const body = docOf(
  ["ph-000001", "ph-000002", "ph-000003", "ph-000004", "ph-000005"],
  heading("ph-000001", "Intro", 1),
  heading("ph-000002", "How it works"),
  heading("ph-000003", "The details", 3),
  heading("ph-000004", "More details", 3),
  heading("ph-000005", "Content"),
)
const authors = [
  { username: "ana", full_name: "Ana Costa", avatar: "/uploads/media/_avatars/avatar-0123456789abcdef0123456789abcdef.jpg", bio: "Writes the guides.", website: "" },
  { username: "luan", full_name: "", avatar: null, bio: "", website: "" },
] as unknown as AuthorProfile[]
const related = [item(post(1, "Roles explained"), "/uploads/media/a.jpg"), item(post(2, "Alt text", { authors: [] }), null), item(post(3, "Three authors", { authors: [{ id: 1, username: "ana", full_name: "Ana Costa", avatar: null }, { id: 2, username: "luan", full_name: "", avatar: null }, { id: 3, username: "priya", full_name: "Priya", avatar: null }] } as Partial<Post>), "/uploads/media/c.jpg")]
const routePost: SiteRoutePost = { ...item(post(9, "Shipping collaboration"), null), blocks: body, authors }

const site: SiteRenderContext = {
  inTemplate: true,
  kind: "template",
  site: { title: "GoLive Blog", tagline: "" },
  logo: null,
  menusByLocation: {},
  menusById: {},
  parts: {},
  dates: { language: "en-US", timeZone: "UTC", dateFormat: "month_day_year" },
  route: { kind: "single", post: routePost },
  related: { "related-01": { items: related, page: 1, totalPages: 1, basePath: null } },
}

// A #491 layout renders a block template with the theme's own reserved ids, as its code layouts do.
const renderBlock = (block: B, extra: B[] = []) =>
  renderToStaticMarkup(createElement(BlockRenderer, { doc: docOf([block.id], block, ...extra), site, reservedIds: THEME_ELEMENT_IDS }))

describe("site blocks III render their theme component's markup (#497)", () => {
  it("related_posts is RelatedPosts", async () => {
    const theme = await container.renderToString(RelatedPosts, { props: { posts: related } })
    const block = blockElement(renderBlock(b("related-01", "related_posts")))
    expect(canonical(block)).toBe(canonical(theme))
    expect(block).toContain("Ana Costa, luan and Priya · Oct 18, 2026")
  })

  it("author_cards is AuthorCards", async () => {
    const theme = await container.renderToString(AuthorCards, { props: { authors } })
    const block = blockElement(renderBlock(b("authors-01", "author_cards")))
    expect(canonical(block)).toBe(canonical(theme))
    expect(block).toContain('src="/uploads/media/_avatars/avatar-0123456789abcdef0123456789abcdef.jpg"')
  })

  it("table_of_contents is TableOfContents, with the ids the theme's post layouts give the headings", async () => {
    // The code layouts: headingAnchors(published_blocks, THEME_ELEMENT_IDS), so "Content" is "content-2".
    const entries = tableOfContents(headingAnchors(body, THEME_ELEMENT_IDS))
    expect(entries.map((e) => e.id)).toEqual(["intro", "how-it-works", "content-2"])
    const theme = await container.renderToString(TableOfContents, { props: { entries } })
    const html = renderBlock(b("toc-000001", "table_of_contents"))
    expect(canonical(blockElement(html))).toBe(canonical(theme))
  })

  it("table_of_contents beside post_content links to the ids the post's headings render with", async () => {
    const html = renderToStaticMarkup(
      createElement(BlockRenderer, { doc: docOf(["toc-000001", "content-01"], b("toc-000001", "table_of_contents"), b("content-01", "post_content")), site, reservedIds: THEME_ELEMENT_IDS }),
    )
    const { document } = new JSDOM(html).window
    const links = [...document.querySelectorAll(".toc a")].map((a) => a.getAttribute("href")!.slice(1))
    expect(links).toEqual(["intro", "how-it-works", "the-details", "more-details", "content-2"])
    for (const id of links) expect(document.getElementById(id)?.tagName, id).toMatch(/^H[23]$/)
  })

  it("color_scheme_switch holds ThemeSwitch, in both looks", async () => {
    for (const variant of ["segmented", "menu"] as const) {
      const theme = await container.renderToString(ThemeSwitch, { props: { variant } })
      const html = renderBlock(b("switch-001", "color_scheme_switch", variant === "menu" ? { variant } : {}))
      const { document } = new JSDOM(html).window
      const group = document.querySelector(".block-content > .color-scheme-switch")!
      expect(group.getAttribute("role")).toBe("group")
      expect(group.getAttribute("aria-label")).toBe("Theme")
      expect(canonical(group.innerHTML)).toBe(canonical(theme))
    }
  })
})
