// Heading anchors in the rendered markup (#351).
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import BlockRenderer from "../../BlockRenderer"
import { headingAnchors } from "../utils/headingAnchors"

function doc(...headings: { id: string; text: string; level?: number; align?: string }[]): BlockDocV1 {
  const out = { doc_version: 1, blocks_order: [] as string[], blocks: {} as Record<string, unknown> }
  for (const hd of headings) {
    out.blocks_order.push(hd.id)
    out.blocks[hd.id] = {
      id: hd.id,
      type: "heading",
      version: 1,
      attrs: {
        level: hd.level ?? 2,
        pm: { type: "heading", attrs: { level: hd.level ?? 2, ...(hd.align ? { textAlign: hd.align } : {}) }, ...(hd.text ? { content: [{ type: "text", text: hd.text }] } : {}) },
      },
    }
  }
  return out as unknown as BlockDocV1
}

const render = (d: BlockDocV1, headings?: ReturnType<typeof headingAnchors>) => renderToStaticMarkup(<BlockRenderer doc={d} headings={headings} />)

describe("HeadingBlock ids", () => {
  it("gives every heading a slug id, de-duplicated", () => {
    const html = render(doc({ id: "a", text: "How it works" }, { id: "b", text: "How it works", level: 3 }, { id: "c", text: "Café", level: 4 }, { id: "d", text: "" }))
    expect(html).toContain('<h2 id="how-it-works"')
    expect(html).toContain('<h3 id="how-it-works-2"')
    expect(html).toContain('<h4 id="cafe"')
    expect(html).toContain('<h2 id="section"')
  })

  it("renders the same ids on every render", () => {
    const d = doc({ id: "a", text: "日本語" }, { id: "b", text: "日本語" })
    expect(render(d)).toBe(render(JSON.parse(JSON.stringify(d))))
    expect(render(d)).toContain('id="日本語-2"')
  })

  it("uses the ids the layout passes (shared with its table of contents)", () => {
    const d = doc({ id: "a", text: "Content" })
    expect(render(d, headingAnchors(d, ["content"]))).toContain('<h2 id="content-2"')
  })

  it("keeps the level, text and alignment", () => {
    const html = render(doc({ id: "a", text: "Centered", level: 5, align: "center" }))
    expect(html).toBe('<div class="block-content"><h5 id="centered" style="text-align:center">Centered</h5></div>')
  })

  it("renders an out-of-range level as an h1", () => {
    expect(render(doc({ id: "a", text: "Odd", level: 9 }))).toContain('<h1 id="odd"')
  })
})
