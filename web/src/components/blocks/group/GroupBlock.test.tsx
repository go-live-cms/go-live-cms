import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import BlockRenderer from "../../BlockRenderer"
import { headingAnchors } from "../utils/headingAnchors"
import { isFirstImageBlock } from "../utils/responsiveImage"
import { firstParagraphText, postExcerpt } from "../../../lib/seo"

// The Group block on the public page (#414): its children render through renderBlock
// at any depth, with the markup the default theme styles, and the helpers that read the
// doc (heading anchors, the eager first image, the first-paragraph fallback) look inside.

const GROUP = "blk-group-000001"
const HEAD = "blk-head-0000001"
const PARA = "blk-para-0000001"
const IMG = "blk-image-000001"
const LATER = "blk-image-000002"
const LIST = "blk-list-0000001"
const ITEM = "blk-item-0000001"

function doc(attrs: Record<string, unknown> = { style: "tinted" }): BlockDocV1 {
  return {
    doc_version: 1,
    blocks_order: [GROUP, LATER],
    blocks: {
      [GROUP]: { id: GROUP, type: "group", version: 1, attrs, children: [HEAD, PARA, IMG, LIST] },
      [HEAD]: { id: HEAD, type: "heading", version: 1, attrs: { level: 2, text: "Office hours" } },
      [PARA]: { id: PARA, type: "paragraph", version: 1, attrs: { text: "Every Tuesday, bring a question." } },
      [IMG]: { id: IMG, type: "image", version: 2, attrs: { src: "/uploads/media/a.jpg", alt: "A room", mediaId: 12 } },
      [LIST]: { id: LIST, type: "bullet_list", version: 1, attrs: {}, children: [ITEM] },
      [ITEM]: { id: ITEM, type: "list_item", version: 1, attrs: { text: "Editor" } },
      [LATER]: { id: LATER, type: "image", version: 2, attrs: { src: "/uploads/media/b.jpg", alt: "B" } },
    },
    media: {
      "12": {
        media_path: "/uploads/media/a.jpg",
        width: 1600,
        height: 900,
        variants: { medium: { path: "/uploads/media/_variants/a.jpg/medium.jpg", width: 800, height: 450 } },
      },
    },
  } as unknown as BlockDocV1
}

const render = (d: BlockDocV1) => renderToStaticMarkup(<BlockRenderer doc={d} />)

describe("GroupBlock (#414)", () => {
  it("renders its blocks inside div.group, with the anchor id on the group", () => {
    const html = render(doc())
    expect(html).toContain(`<div id="b-${GROUP}" class="group is-tinted">`)
    expect(html).toMatch(/<div id="b-blk-group-000001" class="group is-tinted"><h2[^>]*>.*Office hours.*<\/h2><p>Every Tuesday, bring a question.<\/p>.*<img.*<ul><li>Editor<\/li><\/ul><\/div>/)
    // Nested blocks get no block anchor of their own.
    expect(html).not.toContain(`id="b-${PARA}"`)
  })

  it("maps style and width to the theme's classes; unknown values render the defaults", () => {
    expect(render(doc({}))).toContain(`class="group"`)
    expect(render(doc({ align: "wide" }))).toContain(`class="group alignwide"`)
    expect(render(doc({ style: "tinted", align: "full" }))).toContain(`class="group is-tinted alignfull"`)
    expect(render(doc({ style: "<script>", align: "huge" }))).toContain(`class="group"`)
  })

  it("a heading inside a group gets an anchor", () => {
    expect(headingAnchors(doc()).map((h) => [h.blockId, h.id])).toEqual([[HEAD, "office-hours"]])
    expect(render(doc())).toContain('<h2 id="office-hours"')
  })

  it("the first image inside a group loads eagerly, with its srcset; a later one is lazy", () => {
    expect(isFirstImageBlock(doc(), IMG)).toBe(true)
    expect(isFirstImageBlock(doc(), LATER)).toBe(false)
    const html = render(doc())
    const first = html.match(/<img[^>]*a\.jpg[^>]*>/)![0]
    expect(first).toContain("srcSet=")
    expect(first).toContain("/uploads/media/_variants/a.jpg/medium.jpg 800w")
    expect(first).not.toContain('loading="lazy"')
    expect(html.match(/<img[^>]*b\.jpg[^>]*>/)![0]).toContain('loading="lazy"')
  })

  it("a post whose first paragraph is inside a group gets it as its description fallback", () => {
    expect(firstParagraphText(doc())).toBe("Every Tuesday, bring a question.")
    expect(postExcerpt({ description: "", published_blocks: doc() } as any)).toBe("Every Tuesday, bring a question.")
  })
})
