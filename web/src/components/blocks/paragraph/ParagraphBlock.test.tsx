import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { Block, BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { getBlockContent, renderContent } from "../utils/contentRenderer"
import ParagraphBlock from "./ParagraphBlock"

const paragraph = (pm: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}): Block =>
  ({ id: "blk-para-000001", type: "paragraph", version: 1, attrs: { ...(pm ? { pm } : {}), ...extra } }) as unknown as Block

const pmParagraph = (content?: unknown[], attrs: Record<string, unknown> = {}) => ({
  type: "paragraph",
  attrs,
  ...(content ? { content } : {}),
})

const render = (block: Block) =>
  renderToStaticMarkup(
    <ParagraphBlock
      block={block}
      doc={{} as BlockDocV1}
      renderContent={renderContent}
      getBlockContent={getBlockContent}
      renderBlock={() => null}
    />,
  )

describe("ParagraphBlock", () => {
  it("renders text content in a <p>", () => {
    expect(render(paragraph(pmParagraph([{ type: "text", text: "Hello" }])))).toBe("<p>Hello</p>")
  })

  it("renders a blank paragraph as a blank line instead of dropping it (#306)", () => {
    const blanks = [
      paragraph(pmParagraph()), // no content (an empty line)
      paragraph(pmParagraph([])),
      paragraph(pmParagraph([{ type: "text", text: "   " }])), // whitespace only
      paragraph(undefined, { text: "" }), // plain-text fallback
      paragraph(undefined, { text: "  " }),
    ]
    for (const block of blanks) {
      expect(render(block)).toBe("<p><br/></p>")
    }
  })

  it("treats a hard break as content, not a blank line", () => {
    expect(render(paragraph(pmParagraph([{ type: "hardBreak" }])))).toBe("<p><br/></p>")
    expect(render(paragraph(pmParagraph([{ type: "text", text: "a" }, { type: "hardBreak" }])))).toBe("<p>a<br/></p>")
  })

  it("keeps the alignment of a blank paragraph", () => {
    expect(render(paragraph(pmParagraph(undefined, { textAlign: "center" })))).toBe('<p style="text-align:center"><br/></p>')
  })
})
