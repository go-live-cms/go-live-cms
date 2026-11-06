// Block anchors (#356, "Copy link to block"): BlockRenderer gives every top-level block the
// element id `b-<block id>`, where the editor's copied link points. Headings keep their
// #351 slug as their id and carry the anchor on an empty span; list items and the blocks
// inside a block get none. No heading slug may take one of these ids.
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { blockAnchorId, type BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import BlockRenderer from "./BlockRenderer"
import { headingAnchors } from "./blocks/utils/headingAnchors"

const ID = (n: number) => `3b0e8f1c-0000-4000-8000-${String(n).padStart(12, "0")}`
const t = (text: string) => [{ type: "text", text }]

const blocks: Record<string, any> = {
  [ID(1)]: { id: ID(1), type: "paragraph", version: 1, attrs: { pm: { type: "paragraph", content: t("para") } } },
  [ID(2)]: { id: ID(2), type: "heading", version: 1, attrs: { level: 2, pm: { type: "heading", content: t("Section") } } },
  [ID(3)]: { id: ID(3), type: "blockquote", version: 2, attrs: { pm: { type: "blockquote", content: [{ type: "paragraph", content: t("q") }] } } },
  [ID(4)]: { id: ID(4), type: "code_block", version: 1, attrs: { code: "x = 1", language: "js" } },
  [ID(5)]: { id: ID(5), type: "divider", version: 1, attrs: {} },
  [ID(6)]: { id: ID(6), type: "image", version: 2, attrs: { src: "/uploads/a.jpg", alt: "a" } },
  [ID(7)]: { id: ID(7), type: "image", version: 2, attrs: { src: "/uploads/b.jpg", alt: "b", align: "wide" } },
  [ID(8)]: { id: ID(8), type: "bullet_list", version: 1, attrs: {}, children: [ID(9)] },
  [ID(9)]: { id: ID(9), type: "list_item", version: 1, attrs: { pm: { type: "listItem", content: [{ type: "paragraph", content: t("li") }] } } },
  [ID(10)]: { id: ID(10), type: "ordered_list", version: 1, attrs: {}, children: [ID(11)] },
  [ID(11)]: { id: ID(11), type: "list_item", version: 1, attrs: { pm: { type: "listItem", content: [{ type: "paragraph", content: t("oli") }] } } },
  [ID(12)]: { id: ID(12), type: "theme:example/alert", version: 1, attrs: { variant: "info", pm: { type: "theme:example/alert", content: t("alert") } } },
}
const doc = { doc_version: 1, blocks_order: [1, 2, 3, 4, 5, 6, 7, 8, 10, 12].map(ID), blocks } as unknown as BlockDocV1
const render = (d: BlockDocV1) => renderToStaticMarkup(<BlockRenderer doc={d} />)

describe("block anchors on the public page (#356)", () => {
  const html = render(doc)
  const count = (id: string) => html.split(`id="${id}"`).length - 1

  it.each([
    ["paragraph", 1, "<p id"],
    ["blockquote", 3, "<blockquote id"],
    ["code block", 4, "<pre id"],
    ["divider", 5, "<hr id"],
    ["bare image", 6, "<img id"],
    ["image in a figure", 7, "<figure id"],
    ["bullet list", 8, "<ul id"],
    ["ordered list", 10, "<ol id"],
    ["theme block", 12, '<div id'],
  ])("puts b-<id> on the %s's element", (_label, n, opening) => {
    expect(count(`b-${ID(n as number)}`)).toBe(1)
    const tag = (opening as string).replace(" id", "")
    expect(html).toMatch(new RegExp(`${tag}[^>]* id="b-${ID(n as number)}"`))
  })

  it("keeps the heading's slug id and puts the block anchor on a span at its start", () => {
    expect(html).toContain(`<h2 id="section"><span id="b-${ID(2)}" class="gl-block-anchor"></span>Section</h2>`)
  })

  it("gives list items and nested blocks no anchor", () => {
    expect(count(`b-${ID(9)}`)).toBe(0)
    expect(count(`b-${ID(11)}`)).toBe(0)
  })

  it("never lets a heading slug take a block anchor", () => {
    // A heading whose text slugs to another block's anchor id.
    const tricky = {
      ...doc,
      blocks: {
        ...blocks,
        [ID(2)]: { ...blocks[ID(2)], attrs: { level: 2, pm: { type: "heading", content: t(`b-${ID(1)}`) } } },
      },
    } as unknown as BlockDocV1
    const [anchor] = headingAnchors(tricky)
    expect(anchor.id).toBe(`b-${ID(1)}-2`)
    const out = render(tricky)
    expect(out.split(`id="b-${ID(1)}"`).length - 1).toBe(1)
  })

  it("gives no anchor for an id that isn't safe as an HTML id", () => {
    expect(blockAnchorId("short")).toBeNull()
    expect(blockAnchorId('x"><img src=x onerror=alert(1)>yyyy')).toBeNull()
    expect(blockAnchorId("has space in it")).toBeNull()
    expect(blockAnchorId(ID(1))).toBe(`b-${ID(1)}`)
    const odd = { doc_version: 1, blocks_order: ["has space in it"], blocks: { "has space in it": { id: "has space in it", type: "paragraph", version: 1, attrs: { text: "x" } } } } as unknown as BlockDocV1
    expect(render(odd)).toBe('<div class="block-content"><p>x</p></div>')
  })
})
