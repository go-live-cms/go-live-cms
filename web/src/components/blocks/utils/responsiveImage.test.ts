import { describe, expect, it } from "vitest"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import ImageBlock from "../image/ImageBlock"
import BlockRenderer from "../../BlockRenderer"
import { BLOCK_IMAGE_SIZES, blockMediaFor, isFirstImageBlock, responsiveImageAttrs, type BlockMedia } from "./responsiveImage"

const media: BlockMedia = {
  media_path: "/uploads/media/hero.jpg",
  width: 2000,
  height: 1000,
  variants: {
    thumb: { path: "/uploads/media/_variants/hero.jpg/thumb.jpg", width: 320, height: 160 },
    large: { path: "/uploads/media/_variants/hero.jpg/large.jpg", width: 1600, height: 800 },
    medium: { path: "/uploads/media/_variants/hero.jpg/medium.jpg", width: 800, height: 400 },
  },
  focal_point: { x: 0.25, y: 0.8 },
}

describe("responsiveImageAttrs", () => {
  it("builds srcset smallest first with the original as the largest candidate", () => {
    const attrs = responsiveImageAttrs("/uploads/media/hero.jpg", media)
    expect(attrs.src).toBe("/uploads/media/hero.jpg")
    expect(attrs.srcSet).toBe(
      "/uploads/media/_variants/hero.jpg/thumb.jpg 320w, " +
        "/uploads/media/_variants/hero.jpg/medium.jpg 800w, " +
        "/uploads/media/_variants/hero.jpg/large.jpg 1600w, " +
        "/uploads/media/hero.jpg 2000w"
    )
    expect(attrs.sizes).toBe(BLOCK_IMAGE_SIZES)
    expect(attrs.width).toBe(2000)
    expect(attrs.height).toBe(1000)
    expect(attrs.objectPosition).toBe("25% 80%")
  })

  it("is just the sanitized src without media info", () => {
    expect(responsiveImageAttrs("/uploads/a.png", undefined)).toEqual({ src: "/uploads/a.png" })
    expect(responsiveImageAttrs("javascript:alert(1)", media)).toEqual({ src: "" })
  })

  it("has no srcset without variants, but keeps size and focal point", () => {
    const attrs = responsiveImageAttrs("/uploads/media/hero.jpg", { ...media, variants: {} })
    expect(attrs.srcSet).toBeUndefined()
    expect(attrs.sizes).toBeUndefined()
    expect(attrs.width).toBe(2000)
    expect(attrs.objectPosition).toBe("25% 80%")
  })

  it("drops unsafe or unparseable variant URLs", () => {
    const attrs = responsiveImageAttrs("/uploads/media/hero.jpg", {
      ...media,
      variants: {
        thumb: { path: "javascript:alert(1)", width: 320, height: 160 },
        medium: { path: "/uploads/has space.jpg", width: 800, height: 400 },
        large: { path: "uploads/ok.jpg", width: 1600, height: 800 },
      },
    })
    expect(attrs.srcSet).toBe("/uploads/ok.jpg 1600w, /uploads/media/hero.jpg 2000w")
  })

  it("turns media_path-style relative paths into site URLs", () => {
    const attrs = responsiveImageAttrs("/uploads/media/a.jpg", {
      ...media,
      media_path: "./uploads/media/a.jpg",
      variants: { thumb: { path: "./uploads/media/_variants/a.jpg/thumb.jpg", width: 320, height: 160 } },
    })
    expect(attrs.srcSet).toBe("/uploads/media/_variants/a.jpg/thumb.jpg 320w, /uploads/media/a.jpg 2000w")
  })

  it("ignores a malformed focal point and clamps out-of-range values", () => {
    const injected = { x: "1; background:red" as unknown as number, y: 0.5 }
    expect(responsiveImageAttrs("/uploads/media/hero.jpg", { ...media, focal_point: injected }).objectPosition).toBeUndefined()
    expect(responsiveImageAttrs("/uploads/media/hero.jpg", { ...media, focal_point: { x: 3, y: -1 } }).objectPosition).toBe("100% 0%")
  })

  it("ignores media info whose file isn't the block's src", () => {
    // e.g. legacy media replaced to a new path while the block kept the old src
    expect(responsiveImageAttrs("/uploads/old/hero.jpg", media)).toEqual({ src: "/uploads/old/hero.jpg" })
    // a version query on the src is fine
    expect(responsiveImageAttrs("/uploads/media/hero.jpg?v=3", media).srcSet).toContain("2000w")
  })

  it("uses the layout's sizes", () => {
    expect(responsiveImageAttrs("/uploads/media/hero.jpg", media, "100vw").sizes).toBe("100vw")
  })
})

describe("isFirstImageBlock", () => {
  const doc = {
    doc_version: 1,
    blocks_order: ["p", "a", "b"],
    blocks: { p: { type: "paragraph" }, a: { type: "image" }, b: { type: "image" } },
  } as unknown as BlockDocV1

  it("is true only for the first image in order", () => {
    expect(isFirstImageBlock(doc, "a")).toBe(true)
    expect(isFirstImageBlock(doc, "b")).toBe(false)
    expect(isFirstImageBlock(doc, "p")).toBe(false)
  })
})

describe("ImageBlock", () => {
  const doc = {
    doc_version: 1,
    blocks_order: ["img"],
    blocks: {
      img: { id: "img", type: "image", attrs: { src: "/uploads/media/hero.jpg", alt: "Hero", mediaId: 12 } },
    },
    media: { "12": media },
  } as unknown as BlockDocV1

  const render = (d: BlockDocV1) =>
    renderToStaticMarkup(
      React.createElement(ImageBlock, {
        block: (d.blocks as Record<string, any>).img,
        doc: d,
        renderContent: () => null,
        getBlockContent: () => null,
        renderBlock: () => null,
      })
    )

  it("renders srcset, sizes and object-position from the attached media", () => {
    expect(blockMediaFor(doc, 12)).toBe(media)
    const html = render(doc)
    expect(html).toContain('srcSet="/uploads/media/_variants/hero.jpg/thumb.jpg 320w')
    expect(html).toContain(`sizes="${BLOCK_IMAGE_SIZES}"`)
    expect(html).toContain('style="object-position:25% 80%"')
    expect(html).toContain('width="2000"')
    expect(html).toContain('alt="Hero"')
  })

  it("renders a plain img for docs without media info", () => {
    const html = render({ ...doc, media: undefined } as unknown as BlockDocV1)
    expect(html).not.toContain("srcSet")
    expect(html).toContain('src="/uploads/media/hero.jpg"')
  })

  it("loads the first image eagerly and later ones lazily", () => {
    const two = {
      ...doc,
      blocks_order: ["img", "img2"],
      blocks: { ...(doc.blocks as object), img2: { id: "img2", type: "image", attrs: { src: "/uploads/b.jpg" } } },
    } as unknown as BlockDocV1
    const html = renderToStaticMarkup(React.createElement(BlockRenderer, { doc: two }))
    const [first, second] = html.split("<img").slice(1)
    expect(first).not.toContain('loading="lazy"')
    expect(second).toContain('loading="lazy"')
  })

  it("takes sizes from BlockRenderer's imageSizes", () => {
    const html = renderToStaticMarkup(React.createElement(BlockRenderer, { doc, imageSizes: "100vw" }))
    expect(html).toContain('sizes="100vw"')
  })
})
