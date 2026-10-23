import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { Block, BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import ParagraphBlock from "./ParagraphBlock"

const block = (attrs: Record<string, unknown> = {}): Block =>
  ({ id: "blk-para-000001", type: "paragraph", version: 1, attrs }) as unknown as Block

const render = (content: React.ReactNode, attrs?: Record<string, unknown>) =>
  renderToStaticMarkup(
    <ParagraphBlock
      block={block(attrs)}
      doc={{} as BlockDocV1}
      getBlockContent={() => content}
      renderBlock={() => null}
    />,
  )

describe("ParagraphBlock", () => {
  it("renders text content in a <p>", () => {
    expect(render("Hello")).toBe("<p>Hello</p>")
  })

  it("renders an empty paragraph as a blank line instead of dropping it (#306)", () => {
    for (const empty of [null, undefined, "", false, [], ["", null]]) {
      expect(render(empty as React.ReactNode)).toBe("<p><br/></p>")
    }
  })

  it("keeps the alignment of an empty paragraph", () => {
    expect(render("", { pm: { attrs: { textAlign: "center" } } })).toBe('<p style="text-align:center"><br/></p>')
  })
})
