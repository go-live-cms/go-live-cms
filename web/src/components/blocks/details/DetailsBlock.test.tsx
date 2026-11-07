import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import BlockRenderer from "../../BlockRenderer"
import { headingAnchors } from "../utils/headingAnchors"
import { isFirstImageBlock } from "../utils/responsiveImage"

// The Details block on the public page (#421, the canvas's "Published · text"): the
// browser's own <details>/<summary>, so it opens and closes with no script; `open` only
// when the block says so; the summary's runs with their marks; its blocks rendered through
// renderBlock like any child, so a heading in one gets an anchor and an image in one is
// the first image when it comes first.

const DETAILS = "blk-details-00001"
const CLOSED = "blk-details-00002"
const HEAD = "blk-head-0000001"
const PARA = "blk-para-0000001"
const IMG = "blk-image-000001"
const P2 = "blk-para-0000002"

function doc(attrs: Record<string, unknown> = { open: true, summary: [{ type: "text", text: "Can " }, { type: "text", text: "contributors", marks: [{ type: "bold" }] }, { type: "text", text: " publish?" }] }): BlockDocV1 {
  return {
    doc_version: 1,
    blocks_order: [DETAILS, CLOSED],
    blocks: {
      [DETAILS]: { id: DETAILS, type: "details", version: 1, attrs, children: [HEAD, PARA, IMG] },
      [HEAD]: { id: HEAD, type: "heading", version: 1, attrs: { level: 3, text: "Publishing" } },
      [PARA]: { id: PARA, type: "paragraph", version: 1, attrs: { text: "No. An editor or admin publishes." } },
      [IMG]: { id: IMG, type: "image", version: 2, attrs: { src: "/uploads/media/a.jpg", alt: "A" } },
      [CLOSED]: { id: CLOSED, type: "details", version: 1, attrs: { summary: [{ type: "text", text: "Who owns a post?" }] }, children: [P2] },
      [P2]: { id: P2, type: "paragraph", version: 1, attrs: { text: "The person who created it." } },
    },
  } as unknown as BlockDocV1
}

const render = (d: BlockDocV1) => renderToStaticMarkup(<BlockRenderer doc={d} />)

describe("DetailsBlock (#421)", () => {
  it("renders <details open><summary> with the summary's marks, then its blocks, with the anchor on the details", () => {
    const html = render(doc())
    expect(html).toContain(`<details id="b-${DETAILS}" open=""><summary>Can <strong>contributors</strong> publish?</summary>`)
    expect(html).toMatch(/<summary>.*<\/summary><h3[^>]*>.*Publishing.*<\/h3><p>No\. An editor or admin publishes\.<\/p><img[^>]*><\/details>/)
    // Nested blocks get no block anchor of their own.
    expect(html).not.toContain(`id="b-${PARA}"`)
  })

  it("is closed unless the block says open: true (no script: the browser toggles it)", () => {
    const html = render(doc())
    expect(html).toContain(`<details id="b-${CLOSED}"><summary>Who owns a post?</summary><p>The person who created it.</p></details>`)
    expect(render(doc({ open: "yes" }))).toContain(`<details id="b-${DETAILS}"><summary></summary>`)
    expect(html).not.toContain("<script")
  })

  it("keeps only the caption marks in the summary, and renders an empty one as an empty <summary>", () => {
    const html = render(doc({ summary: [{ type: "text", text: "x", marks: [{ type: "code" }, { type: "italic" }] }, { type: "image", attrs: { src: "/a.png" } }] }))
    expect(html).toContain("<summary><em>x</em></summary>")
    expect(render(doc({}))).toContain("<summary></summary>")
  })

  it("renders nothing when none of its blocks can be rendered", () => {
    const d = doc()
    ;(d.blocks[CLOSED] as any).children = ["blk-missing-0001"]
    expect(render(d)).not.toContain(`b-${CLOSED}`)
  })

  it("a heading inside a details gets an anchor, and an image in the first one is the first image", () => {
    expect(headingAnchors(doc()).map((h) => [h.blockId, h.id])).toEqual([[HEAD, "publishing"]])
    expect(render(doc())).toContain('<h3 id="publishing"')
    expect(isFirstImageBlock(doc(), IMG)).toBe(true)
  })
})
