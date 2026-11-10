import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import BlockRenderer from "../../BlockRenderer"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"

// The published custom HTML block (#428, "Published · layout"): the one place the site
// outputs raw HTML, and only `attrs.html`, the string the API sanitized on publish.

const SNIPPET = "11111111-1111-4111-8111-111111111111"
const ID = "html-block-000001"

function docWith(attrs: Record<string, unknown>): BlockDocV1 {
  return { doc_version: 1, blocks_order: [ID], blocks: { [ID]: { id: ID, type: "html", version: 1, attrs } } } as unknown as BlockDocV1
}

const page = (attrs: Record<string, unknown>) => renderToStaticMarkup(<BlockRenderer doc={docWith(attrs)} />)

describe("the published custom HTML block", () => {
  it("outputs the published markup as written", () => {
    const html = `<dl class="office-hours"><dt>Office hours</dt><dd>Tuesdays</dd></dl>`
    expect(page({ snippetId: SNIPPET, html })).toContain(html)
  })

  it("carries the block's anchor, like every top-level block", () => {
    expect(page({ snippetId: SNIPPET, html: "<p>x</p>" })).toContain(`id="b-${ID}"`)
  })

  it("renders nothing without published markup: a working block, or another post's snippet", () => {
    expect(page({ snippetId: SNIPPET })).not.toContain("html-block")
    expect(page({})).not.toContain("html-block")
    expect(page({ snippetId: SNIPPET, html: "" })).not.toContain("html-block")
  })

  it("ignores anything that isn't a string", () => {
    expect(page({ html: { __html: "<script>alert(1)</script>" } })).not.toContain("script")
    expect(page({ html: 12 })).not.toContain("12")
  })

  it("doesn't print the snippet id", () => {
    expect(page({ snippetId: SNIPPET, html: "<p>x</p>" })).not.toContain(SNIPPET)
  })
})
