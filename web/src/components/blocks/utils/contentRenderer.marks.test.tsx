import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { Block, BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { getBlockContent, renderContent } from "./contentRenderer"
import ParagraphBlock from "../paragraph/ParagraphBlock"

// Inline marks on the public page (#418, "Published · text · 1280", Paragraph and inline
// formatting): <mark>, <sup> and <sub>, which the theme styles (themes/default
// theme.css: one highlight colour, sup/sub that don't change the line height).

const text = (value: string, ...marks: Record<string, unknown>[]) => ({ type: "text", text: value, ...(marks.length ? { marks } : {}) })

const html = (content: unknown[]) => renderToStaticMarkup(<>{renderContent(content as never)}</>)

const paragraph = (content: unknown[]): Block =>
  ({ id: "blk-0418-render-0001", type: "paragraph", version: 1, attrs: { pm: { type: "paragraph", content } } }) as unknown as Block

const render = (block: Block) =>
  renderToStaticMarkup(
    <ParagraphBlock block={block} doc={{} as BlockDocV1} renderContent={renderContent} getBlockContent={getBlockContent} renderBlock={() => null} />,
  )

describe("inline marks in the public renderer (#418)", () => {
  it("renders highlight, superscript and subscript as <mark>, <sup> and <sub>", () => {
    expect(
      render(
        paragraph([
          text("H"),
          text("2", { type: "subscript" }),
          text("O and x"),
          text("2", { type: "superscript" }),
          text(" "),
          text("what matters", { type: "highlight" }),
        ]),
      ),
    ).toBe("<p>H<sub>2</sub>O and x<sup>2</sup> <mark>what matters</mark></p>")
  })

  it("a highlight is the theme's one colour: a stored colour never becomes a style", () => {
    for (const color of ["#ff0000", "red", "red; background:url(x)", "url(javascript:alert(1))"]) {
      expect(html([text("x", { type: "highlight", attrs: { color } })])).toBe("<mark>x</mark>")
    }
  })

  it("nests with the other marks in schema order, a link inside the highlight", () => {
    expect(
      html([text("ref", { type: "bold" }, { type: "link", attrs: { href: "https://example.com" } }, { type: "highlight" }, { type: "superscript" })]),
    ).toBe('<sup><mark><a href="https://example.com"><strong>ref</strong></a></mark></sup>')
  })

  it("works in nested paragraphs too (a list item's, a quote's)", () => {
    expect(html([{ type: "paragraph", content: [text("CO"), text("2", { type: "subscript" })] }])).toBe("CO<sub>2</sub>")
  })

  it("an unknown mark renders its text only", () => {
    expect(html([text("plain", { type: "spoiler" })])).toBe("plain")
  })
})
