import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import BlockRenderer from "../BlockRenderer"
import { isFirstImageBlock } from "./utils/responsiveImage"

// Cover and media & text on the public page (#427, the canvas's "Published · media & embeds"):
// the markup the theme styles at 1280 and 375 (themes/default/coverBlocks.test.ts checks the
// widths), object-position, srcset, the eager first image, alt text and missing media.

const COVER = "blk-cover-000001"
const MEDIA = "blk-media-000001"
const H = "blk-head-0000001"
const P = "blk-para-0000001"
const IMG = "blk-image-000001"
const GROUP = "blk-group-000001"

const towers = {
  media_path: "/uploads/media/towers.jpg",
  width: 1500,
  height: 1000,
  variants: {
    thumb: { path: "/uploads/media/_variants/towers.jpg/thumb.jpg", width: 320, height: 213 },
    large: { path: "/uploads/media/_variants/towers.jpg/large.jpg", width: 1200, height: 800 },
  },
  focal_point: { x: 0.25, y: 0.75 },
}

function doc(blocks: Record<string, unknown>, order: string[], extra: Record<string, unknown> = {}): BlockDocV1 {
  return { doc_version: 1, blocks_order: order, blocks, ...extra } as unknown as BlockDocV1
}

const text = (id: string, type: string, attrs: Record<string, unknown>) => ({ id, type, version: 1, attrs })
const cover = (attrs: Record<string, unknown> = {}) => ({
  [COVER]: { id: COVER, type: "cover", version: 1, attrs: { mediaId: 1, overlay: 55, decorative: true, ...attrs }, children: [H, P] },
  [H]: text(H, "heading", { level: 2, text: "Notes" }),
  [P]: text(P, "paragraph", { text: "Updates" }),
})
const mediaText = (attrs: Record<string, unknown> = {}) => ({
  [MEDIA]: { id: MEDIA, type: "media_text", version: 1, attrs: { mediaId: 2, alt: "A low orange sun", decorative: false, ...attrs }, children: [P] },
  [P]: text(P, "paragraph", { text: "Faster" }),
})

const render = (d: BlockDocV1) => renderToStaticMarkup(<BlockRenderer doc={d} />)
const withMedia = { media: { "1": towers, "2": { ...towers, media_path: "/uploads/media/dunes.jpg" } } }

describe("CoverBlock (#427)", () => {
  it("renders the image behind its blocks, the overlay as --dim", () => {
    const html = render(doc(cover(), [COVER], withMedia))
    expect(html).toContain(`<div id="b-${COVER}" class="cover" style="--dim:0.55">`)
    expect(html).toContain('<div class="cover-inner">')
    expect(html.indexOf("<img")).toBeLessThan(html.indexOf("cover-inner"))
    expect(html).toContain("<h2")
    expect(html).toContain("Notes")
    expect(html).toContain("Updates")
  })

  it("srcset comes from the media's variants, with the original", () => {
    const html = render(doc(cover(), [COVER], withMedia))
    expect(html).toContain('src="/uploads/media/towers.jpg"')
    expect(html).toContain("/uploads/media/_variants/towers.jpg/thumb.jpg 320w")
    expect(html).toContain("/uploads/media/towers.jpg 1500w")
    expect(html).toContain('width="1500"')
    expect(html).toContain('sizes="(max-width: 640px) 100vw, 680px"')
  })

  it("its own focal point wins over the media's; without one it uses the media's", () => {
    expect(render(doc(cover({ focal: { x: 10, y: 90 } }), [COVER], withMedia))).toContain("object-position:10% 90%")
    expect(render(doc(cover(), [COVER], withMedia))).toContain("object-position:25% 75%")
  })

  it("is decorative by default, so alt is empty even when the block has some", () => {
    expect(render(doc(cover({ alt: "Towers" }), [COVER], withMedia))).toContain('alt=""')
  })

  it("uses its alt text when told it isn't decorative, unless the media is", () => {
    expect(render(doc(cover({ alt: "Towers", decorative: false }), [COVER], withMedia))).toContain('alt="Towers"')
    expect(render(doc(cover({ alt: "Towers", decorative: false }), [COVER], { media: { "1": { ...towers, decorative: true } } }))).toContain('alt=""')
  })

  it("the width classes", () => {
    const wide = render(doc(cover({ align: "wide" }), [COVER], withMedia))
    expect(wide).toContain('class="cover alignwide"')
    expect(wide).toContain('sizes="(max-width: 640px) 100vw, 960px"')
    const full = render(doc(cover({ align: "full" }), [COVER], withMedia))
    expect(full).toContain('class="cover alignfull"')
    expect(full).toContain("100vw")
  })

  it("the first image in reading order loads eagerly, even inside a cover", () => {
    const blocks = { ...cover(), [IMG]: { id: IMG, type: "image", version: 2, attrs: { src: "/uploads/media/a.jpg", mediaId: 3 } } }
    const d = doc(blocks, [COVER, IMG], withMedia)
    expect(isFirstImageBlock(d, COVER)).toBe(true)
    expect(isFirstImageBlock(d, IMG)).toBe(false)
    const html = render(d)
    expect(html.indexOf('loading="lazy"')).toBeGreaterThan(html.indexOf("towers.jpg"))
  })

  it("a deleted image's cover is left out, blocks and all, and doesn't take the eager slot", () => {
    const blocks = { ...cover(), [IMG]: { id: IMG, type: "image", version: 2, attrs: { src: "/uploads/media/a.jpg", mediaId: 3 } } }
    const d = doc(blocks, [COVER, IMG], { media_missing: [1] })
    const html = render(d)
    expect(html).not.toContain("cover")
    expect(html).not.toContain("Notes")
    expect(isFirstImageBlock(d, IMG)).toBe(true)
  })

  it("a cover with no image chosen renders nothing", () => {
    expect(render(doc(cover({ mediaId: undefined }), [COVER]))).not.toContain("Notes")
  })

  it("a lookup that failed keeps the blocks, without the picture", () => {
    const html = render(doc(cover(), [COVER]))
    expect(html).toContain("Notes")
    expect(html).not.toContain("<img")
    expect(html).toContain('class="cover"')
  })

  it("a focal point or overlay out of range can't reach the page", () => {
    const html = render(doc(cover({ overlay: 500, focal: { x: 999, y: -5 } }), [COVER], withMedia))
    expect(html).toContain("--dim:0.8")
    expect(html).toContain("object-position:100% 0%")
  })

  it("a URL that isn't under /uploads is never rendered", () => {
    const html = render(doc(cover(), [COVER], { media: { "1": { ...towers, media_path: "https://evil.example/x.jpg" } } }))
    expect(html).toContain("Notes")
    expect(html).not.toContain("evil.example")
    expect(html).not.toContain("<img")
  })
})

describe("MediaTextBlock (#427)", () => {
  it("renders the media first in the markup, so it stays above the text on phones", () => {
    const html = render(doc(mediaText(), [MEDIA], withMedia))
    expect(html).toContain(`<div id="b-${MEDIA}" class="media-text">`)
    expect(html).toContain('<figure class="media-text-media">')
    expect(html).toContain('<div class="media-text-body">')
    expect(html.indexOf("media-text-media")).toBeLessThan(html.indexOf("media-text-body"))
    expect(html).toContain('alt="A low orange sun"')
    expect(html).toContain('sizes="(max-width: 640px) 100vw, 340px"')
  })

  it("is-media-right moves it, by class only: the markup keeps its order", () => {
    const html = render(doc(mediaText({ position: "right" }), [MEDIA], withMedia))
    expect(html).toContain('class="media-text is-media-right"')
    expect(html.indexOf("media-text-media")).toBeLessThan(html.indexOf("media-text-body"))
  })

  it("its focal point goes to object-position", () => {
    expect(render(doc(mediaText({ focal: { x: 50, y: 55 } }), [MEDIA], withMedia))).toContain("object-position:50% 55%")
  })

  it("a decorative one has an empty alt; a block with no alt text publishes alt=\"\"", () => {
    expect(render(doc(mediaText({ decorative: true }), [MEDIA], withMedia))).toContain('alt=""')
    expect(render(doc(mediaText({ alt: undefined }), [MEDIA], withMedia))).toContain('alt=""')
  })

  it("is left out, blocks and all, when its image was deleted", () => {
    const html = render(doc(mediaText(), [MEDIA], { media_missing: [2] }))
    expect(html).not.toContain("media-text")
    expect(html).not.toContain("Faster")
  })

  it("a failed lookup keeps the text in one column", () => {
    const html = render(doc(mediaText(), [MEDIA]))
    expect(html).toContain('class="media-text is-no-media"')
    expect(html).toContain("Faster")
    expect(html).not.toContain("<img")
  })

  it("renders inside a group, and a heading in it gets an anchor", () => {
    const blocks = {
      [GROUP]: { id: GROUP, type: "group", version: 1, attrs: {}, children: [MEDIA] },
      [MEDIA]: { id: MEDIA, type: "media_text", version: 1, attrs: { mediaId: 2 }, children: [H] },
      [H]: text(H, "heading", { level: 2, text: "Inside a block" }),
    }
    const html = render(doc(blocks, [GROUP], withMedia))
    expect(html).toContain('class="media-text"')
    expect(html).toContain('id="inside-a-block"')
  })
})
