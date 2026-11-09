import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import BlockRenderer from "../../BlockRenderer"
import { isFirstImageBlock } from "../utils/responsiveImage"
import { gallerySizes } from "./GalleryBlock"

// The Gallery on the public page (#424, the canvas's "Published · media & embeds" at 1280
// and 375): `ul.gallery` with `--cols`, `sizes` from the column count, each image its own
// block, left out with its caption when empty or when every image's media is gone, and the
// default theme's grid: the column count at 1280, two columns at 375.

const GALLERY = "blk-gallery-00001"
const A = "blk-image-000001"
const B = "blk-image-000002"

function doc(over: { attrs?: Record<string, unknown>; children?: string[]; media?: unknown; media_missing?: number[] } = {}): BlockDocV1 {
  return {
    doc_version: 1,
    blocks_order: [GALLERY],
    blocks: {
      [GALLERY]: { id: GALLERY, type: "gallery", version: 1, attrs: over.attrs ?? { columns: 3, caption: [{ type: "text", text: "Six " }, { type: "text", text: "covers", marks: [{ type: "italic" }] }] }, children: over.children ?? [A, B] },
      [A]: { id: A, type: "image", version: 2, attrs: { src: "/uploads/media/a.jpg", alt: "A red roof", mediaId: 1, caption: [{ type: "text", text: "October" }] } },
      [B]: { id: B, type: "image", version: 2, attrs: { src: "/uploads/media/b.jpg", mediaId: 2, align: "full" } },
    },
    ...(over.media ? { media: over.media } : {}),
    ...(over.media_missing ? { media_missing: over.media_missing } : {}),
  } as unknown as BlockDocV1
}

const render = (d: BlockDocV1) => renderToStaticMarkup(<BlockRenderer doc={d} />)

describe("GalleryBlock (#424)", () => {
  it("renders the grid with its column count, each image in its own <li>, and the caption after", () => {
    const html = render(doc())
    expect(html).toContain(`<figure id="b-${GALLERY}" class="gallery-block">`)
    expect(html).toContain('<ul class="gallery" style="--cols:3">')
    expect(html.match(/<li>/g)).toHaveLength(2)
    expect(html).toContain('<figcaption>Six <em>covers</em></figcaption>')
    expect(html.indexOf("</ul>")).toBeLessThan(html.indexOf("Six "))
  })

  it("keeps each image's own alt and caption; an image with no alt publishes alt=\"\"", () => {
    const html = render(doc())
    expect(html).toContain('alt="A red roof"')
    expect(html).toContain("<figcaption>October</figcaption>")
    expect(html).toContain('src="/uploads/media/b.jpg"')
    expect(html).toMatch(/src="\/uploads\/media\/b\.jpg"[^>]*alt=""/)
  })

  it("an image's own width doesn't apply inside the grid", () => {
    expect(render(doc())).not.toContain("align-full")
  })

  it("the sizes come from the column count, 50vw on a phone", () => {
    expect(gallerySizes(2)).toBe("(max-width: 640px) 50vw, (max-width: 1000px) 50vw, 500px")
    expect(gallerySizes(3)).toBe("(max-width: 640px) 50vw, (max-width: 1000px) 33vw, 333px")
    expect(gallerySizes(4)).toBe("(max-width: 640px) 50vw, (max-width: 1000px) 25vw, 250px")
    const html = render(
      doc({
        attrs: { columns: 4 },
        media: { "1": { media_path: "/uploads/media/a.jpg", width: 1600, height: 1200, variants: { medium: { path: "/uploads/m.jpg", width: 800, height: 600 } } } },
      }),
    )
    expect(html).toContain('sizes="(max-width: 640px) 50vw, (max-width: 1000px) 25vw, 250px"')
  })

  it("an unknown column count reads as 2–4", () => {
    expect(render(doc({ attrs: { columns: 9 } }))).toContain("--cols:4")
    expect(render(doc({ attrs: {} }))).toContain("--cols:3")
  })

  it("leaves an empty gallery out, caption included", () => {
    const html = render(doc({ children: [], attrs: { columns: 3, caption: [{ type: "text", text: "Nothing" }] } }))
    expect(html).not.toContain("gallery-block")
    expect(html).not.toContain("Nothing")
  })

  it("leaves out an image whose media was deleted, with its caption; the others stay", () => {
    const html = render(doc({ media_missing: [1] }))
    expect(html).not.toContain("a.jpg")
    expect(html).not.toContain("October")
    expect(html.match(/<li>/g)).toHaveLength(1)
    expect(html).toContain("b.jpg")
  })

  it("leaves the whole gallery out when every image's media was deleted", () => {
    const html = render(doc({ media_missing: [1, 2] }))
    expect(html).not.toContain("gallery-block")
    expect(html).not.toContain("Six")
  })

  it("the first image of a gallery that opens the post loads eagerly", () => {
    expect(isFirstImageBlock(doc(), A)).toBe(true)
    expect(isFirstImageBlock(doc(), B)).toBe(false)
  })
})

describe("the default theme's gallery at 1280 and 375 (#424)", () => {
  const css = readFileSync(resolve(__dirname, "../../../../themes/default/styles/theme.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
  const rules = (source: string, selector: string) =>
    [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((match) => match[1].trim() === selector).map((match) => match[2])
  const phone = /@media \(max-width: 640px\) \{((?:[^{}]*\{[^{}]*\})*?)\s*\}/g
  const phoneBlocks = [...css.matchAll(phone)].map((match) => match[1]).filter((block) => block.includes(".gallery"))

  it("at 1280 the grid has the block's column count", () => {
    const [grid] = rules(css, ".prose .gallery")
    expect(grid).toContain("display: grid")
    expect(grid).toContain("repeat(var(--cols), minmax(0, 1fr))")
    expect(rules(css, ".prose .gallery img")[0]).toContain("aspect-ratio: 1 / 1")
  })

  it("at 375 it drops to two columns, as the canvas's \"2 on phones\" board", () => {
    expect(phoneBlocks).toHaveLength(1)
    expect(rules(phoneBlocks[0], ".prose .gallery")[0]).toContain("repeat(2, minmax(0, 1fr))")
  })
})
