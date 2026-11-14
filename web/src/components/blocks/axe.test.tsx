// @vitest-environment jsdom
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import axe from "axe-core"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import BlockRenderer from "../BlockRenderer"

// axe-core over a published post body (#481, follow-up from the #144 audit): the blocks the
// audit found problems in, rendered as the public site serves them, under the page's one
// <h1> (the post title is the layout's). jsdom does no layout, so contrast is off (the
// theme's contrast is themes/default/tokens.test.ts). The whole default theme's layouts are
// checked in themes/default/theme.astro.test.ts.

const text = (value: string, marks?: unknown[]) => ({ type: "text", text: value, ...(marks ? { marks } : {}) })
const paragraph = (...content: unknown[]) => ({ type: "paragraph", attrs: { pm: { type: "paragraph", content } } })
const heading = (level: unknown, value: string) => ({ type: "heading", attrs: { level, pm: { type: "heading", attrs: { level }, content: [text(value)] } } })

function docOf(blocks: Record<string, Record<string, unknown>>, order: string[], media: Record<string, unknown> = {}): BlockDocV1 {
  return {
    doc_version: 1,
    blocks_order: order,
    blocks: Object.fromEntries(Object.entries(blocks).map(([id, b]) => [id, { id, version: 1, ...b }])),
    media,
  } as unknown as BlockDocV1
}

// Every block below once failed axe or the audit (#481): a Heading 1 block (a second
// <h1>), an image with no alt of its own (rendered alt=""), an empty details summary (a
// button with no name), a new-tab link (no warning), an embed note not tied to its button.
const post = docOf(
  {
    "head-000001": heading(1, "A heading 1 block"),
    "head-000002": heading(undefined, "No level at all"),
    "para-000001": paragraph(text("Read "), text("the guide", [{ type: "link", attrs: { href: "https://example.org/guide", target: "_blank" } }]), text(".")),
    "image-00001": { type: "image", attrs: { src: "/uploads/media/kite.jpg", mediaId: 5 } },
    "image-00002": { type: "image", attrs: { src: "/uploads/media/rule.png", mediaId: 6, alt: "Ignored" } },
    "details-001": { type: "details", attrs: { summary: [] }, children: ["para-000002"] },
    "para-000002": paragraph(text("Inside the details.")),
    "embed-00001": { type: "embed", attrs: { provider: "youtube", ref: "dQw4w9WgXcQ", title: "Two editors, one draft" } },
  },
  ["head-000001", "head-000002", "para-000001", "image-00001", "image-00002", "details-001", "embed-00001"],
  {
    "5": { media_path: "/uploads/media/kite.jpg", width: 800, height: 600, alt: "A red kite over the dunes" },
    "6": { media_path: "/uploads/media/rule.png", width: 800, height: 8, decorative: true },
  },
)

const body = renderToStaticMarkup(<BlockRenderer doc={post} />)

afterEach(() => {
  document.body.innerHTML = ""
})

async function violations(html: string) {
  document.documentElement.lang = "en"
  document.title = "A post"
  document.body.innerHTML = `<main><article><h1>The post title</h1>${html}</article></main>`
  const result = await axe.run(document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
    rules: { "color-contrast": { enabled: false } },
  })
  return result.violations.map((v) => ({ id: v.id, help: v.help, nodes: v.nodes.map((n) => n.html) }))
}

describe("a published post body (#481)", () => {
  it("has no axe violations", async () => {
    expect(await violations(body)).toEqual([])
  })

  it("has one <h1>, the title: Heading 1 blocks and a missing level are h2s", () => {
    expect(body).not.toContain("<h1")
    expect(body).toContain('<h2 id="a-heading-1-block"')
    expect(body).toContain('<h2 id="no-level-at-all"')
  })

  it("describes an image from the library, and keeps alt=\"\" for the decorative one", () => {
    expect(body).toMatch(/src="\/uploads\/media\/kite\.jpg"[^>]*alt="A red kite over the dunes"/)
    expect(body).toMatch(/src="\/uploads\/media\/rule\.png"[^>]*alt=""/)
  })

  it("names the empty summary, warns of the new tab and describes the embed's button", () => {
    expect(body).toContain('<summary><span class="sr-only">Details</span></summary>')
    expect(body).toContain('the guide<span class="sr-only"> (opens in a new tab)</span></a>')
    expect(body).toContain('aria-describedby="embed-note-embed-00001"')
  })

  it("an image nobody described is reported, not passed off as decorative", async () => {
    const undescribed = renderToStaticMarkup(<BlockRenderer doc={docOf({ "image-00009": { type: "image", attrs: { src: "/uploads/media/x.jpg" } } }, ["image-00009"])} />)
    expect((await violations(undescribed)).map((v) => v.id)).toContain("image-alt")
  })
})
