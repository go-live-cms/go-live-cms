// Blank lines on the public site (#306): kept between blocks and inside quotes, trimmed
// at the end of the document (TipTap's TrailingNode paragraph).
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import BlockRenderer from "./BlockRenderer"
import { isBlankParagraph, renderContent } from "./blocks/utils/contentRenderer"

type Spec = { id: string; type: string; content?: unknown[] }

const text = (t: string) => ({ type: "text", text: t })
const pmPara = (...content: unknown[]) => ({ type: "paragraph", attrs: {}, ...(content.length ? { content } : {}) })

function doc(...specs: Spec[]): BlockDocV1 {
  const out = { doc_version: 1, blocks_order: [] as string[], blocks: {} as Record<string, unknown> }
  for (const s of specs) {
    out.blocks_order.push(s.id)
    out.blocks[s.id] = {
      id: s.id,
      type: s.type,
      version: 1,
      attrs: { pm: { type: s.type, attrs: {}, ...(s.content ? { content: s.content } : {}) } },
    }
  }
  return out as unknown as BlockDocV1
}

const render = (d: BlockDocV1) => renderToStaticMarkup(<BlockRenderer doc={d} />)

describe("BlockRenderer blank paragraphs (#306)", () => {
  it("keeps blank lines between blocks", () => {
    const html = render(doc({ id: "a", type: "paragraph", content: [text("a")] }, { id: "b", type: "paragraph" }, { id: "c", type: "paragraph", content: [text("c")] }))
    expect(html).toContain("<p>a</p><p><br/></p><p>c</p>")
  })

  it("trims blank paragraphs at the end of the document (the editor's trailing paragraph)", () => {
    const html = render(
      doc(
        { id: "a", type: "paragraph", content: [text("a")] },
        { id: "t1", type: "paragraph" },
        { id: "t2", type: "paragraph", content: [text("  ")] },
      ),
    )
    expect(html).toContain("<p>a</p>")
    expect(html).not.toContain("<br/>")
  })

  it("renders nothing extra for a document of only blank paragraphs", () => {
    expect(render(doc({ id: "t", type: "paragraph" }))).not.toContain("<p>")
  })
})

describe("renderContent nested paragraphs (#306)", () => {
  const html = (content: unknown[]) => renderToStaticMarkup(<>{renderContent(content as never)}</>)

  it("separates consecutive paragraphs (a quote's lines no longer run together)", () => {
    expect(html([pmPara(text("x")), pmPara(text("y"))])).toBe("x<br/>y")
  })

  it("keeps a blank line between nested paragraphs", () => {
    expect(html([pmPara(text("x")), pmPara(), pmPara(text("y"))])).toBe("x<br/><br/>y")
  })

  it("renders a single paragraph as before (list items keep their markup)", () => {
    expect(html([pmPara(text("only"))])).toBe("only")
  })
})

describe("isBlankParagraph", () => {
  const block = (pm: unknown, type = "paragraph") => ({ id: "x", type, version: 1, attrs: { pm } }) as never

  it("is true for no content and whitespace-only text", () => {
    expect(isBlankParagraph(block(pmPara()))).toBe(true)
    expect(isBlankParagraph(block(pmPara(text(" \t "))))).toBe(true)
  })

  it("is false for text, hard breaks, other inline nodes and non-paragraph blocks", () => {
    expect(isBlankParagraph(block(pmPara(text("a"))))).toBe(false)
    expect(isBlankParagraph(block(pmPara({ type: "hardBreak" })))).toBe(false)
    expect(isBlankParagraph(block(pmPara({ type: "image", attrs: {} })))).toBe(false)
    expect(isBlankParagraph(block(pmPara(), "heading"))).toBe(false)
    expect(isBlankParagraph(undefined)).toBe(false)
  })
})
