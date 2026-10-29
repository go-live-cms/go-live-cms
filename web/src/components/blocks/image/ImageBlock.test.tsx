import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { Block, BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { getBlockContent, renderContent } from "../utils/contentRenderer"
import BlockquoteBlock from "../blockquote/BlockquoteBlock"
import ImageBlock from "./ImageBlock"

// Caption, width (#346) and, below, the quote citation: the markup the theme styles
// (#345): <figure class="align-wide|align-full">, <figcaption>, <cite> in <blockquote>.

// Another image comes first, so this one is lazy and has no preload link.
const first = { id: "blk-other-000001", type: "image", version: 1, attrs: { src: "/uploads/first.png" } } as Block

const render = (Component: typeof ImageBlock, block: Block) => {
  const doc: BlockDocV1 = { doc_version: 1, blocks_order: [first.id, block.id], blocks: { [first.id]: first, [block.id]: block } }
  return renderToStaticMarkup(
    <Component block={block} doc={doc} renderContent={renderContent} getBlockContent={getBlockContent} renderBlock={() => null} />,
  )
}

const image = (attrs: Record<string, unknown>, version = 2) =>
  ({ id: "blk-image-000001", type: "image", version, attrs: { src: "/uploads/a.png", alt: "A", ...attrs } }) as unknown as Block

describe("ImageBlock", () => {
  it("renders an old image (no caption, no width) as the bare <img> it always was", () => {
    const html = render(ImageBlock, image({}, 1))
    expect(html).toBe('<img src="/uploads/a.png" loading="lazy" decoding="async" alt="A"/>')
    expect(render(ImageBlock, image({ align: "inline" }))).toBe(html)
  })

  it("wraps a captioned image in a <figure> with a <figcaption>, keeping bold, italic and links", () => {
    const html = render(
      ImageBlock,
      image({
        caption: [
          { type: "text", text: "By " },
          { type: "text", text: "Ada", marks: [{ type: "bold" }, { type: "link", attrs: { href: "https://example.com" } }] },
          { type: "text", text: " 2026", marks: [{ type: "italic" }] },
        ],
      }),
    )
    expect(html).toBe(
      '<figure><img src="/uploads/a.png" loading="lazy" decoding="async" alt="A"/>' +
        '<figcaption>By <a href="https://example.com"><strong>Ada</strong></a><em> 2026</em></figcaption></figure>',
    )
  })

  it("puts the width on the figure as align-wide / align-full", () => {
    expect(render(ImageBlock, image({ align: "wide" }))).toMatch(/^<figure class="align-wide"><img [^>]*\/><\/figure>$/)
    expect(render(ImageBlock, image({ align: "full", caption: [{ type: "text", text: "c" }] }))).toMatch(
      /^<figure class="align-full"><img [^>]*\/><figcaption>c<\/figcaption><\/figure>$/,
    )
  })

  it("ignores an unknown width, marks a caption can't carry, and unsafe links", () => {
    const html = render(
      ImageBlock,
      image({
        align: "huge",
        caption: [
          { type: "text", text: "x", marks: [{ type: "code" }, { type: "underline" }] },
          { type: "text", text: "y", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] },
          { type: "hardBreak" },
        ],
      }),
    )
    expect(html).toBe('<figure><img src="/uploads/a.png" loading="lazy" decoding="async" alt="A"/><figcaption>x<a href="#">y</a></figcaption></figure>')
  })

  it("renders an empty or malformed caption as no caption", () => {
    expect(render(ImageBlock, image({ caption: [] }))).toMatch(/^<img /)
    expect(render(ImageBlock, image({ caption: "text" }))).toMatch(/^<img /)
  })
})

const quote = (attrs: Record<string, unknown>, version = 2) =>
  ({
    id: "blk-quote-000001",
    type: "blockquote",
    version,
    attrs: { pm: { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "Quoted" }] }] }, ...attrs },
  }) as unknown as Block

describe("BlockquoteBlock", () => {
  it("renders an old quote exactly as before", () => {
    expect(render(BlockquoteBlock, quote({}, 1))).toBe("<blockquote>Quoted</blockquote>")
    expect(render(BlockquoteBlock, quote({ cite: "   " }))).toBe("<blockquote>Quoted</blockquote>")
  })

  it("renders the citation as <cite> inside the <blockquote>, as plain text", () => {
    expect(render(BlockquoteBlock, quote({ cite: " Ada <b>Lovelace</b> " }))).toBe(
      "<blockquote>Quoted<cite>Ada &lt;b&gt;Lovelace&lt;/b&gt;</cite></blockquote>",
    )
    expect(render(BlockquoteBlock, quote({ cite: 12 }))).toBe("<blockquote>Quoted</blockquote>")
  })
})
