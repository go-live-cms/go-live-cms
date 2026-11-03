import { describe, it, expect, vi } from "vitest"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import BlockRenderer from "./BlockRenderer"
import { log } from "../lib/log"

// Theme blocks on the public page (#376): an installed one renders with its theme's
// renderer, whichever theme is active; one whose theme isn't in this build renders nothing.

const doc = (blocks: BlockDocV1["blocks"]): BlockDocV1 => ({ doc_version: 1, blocks_order: Object.keys(blocks), blocks })

describe("theme blocks in BlockRenderer (#376)", () => {
  it("renders the example theme's alert with its variant and rich content", () => {
    const html = renderToStaticMarkup(
      <BlockRenderer
        doc={doc({
          "blk-alert-0000001": {
            id: "blk-alert-0000001",
            type: "theme:example/alert",
            version: 1,
            attrs: {
              variant: "warning",
              pm: {
                type: "theme:example/alert",
                content: [{ type: "text", text: "Mind", marks: [{ type: "bold" }] }, { type: "text", text: " the gap" }],
              },
              text: "Mind the gap",
            },
          },
        })}
      />,
    )
    expect(html).toContain('class="gl-alert gl-alert--warning"')
    expect(html).toContain("<strong>Mind</strong> the gap")
    expect(html).toContain(">warning</strong>")
  })

  it("an invalid or missing variant renders as the default, never as markup", () => {
    const html = renderToStaticMarkup(
      <BlockRenderer
        doc={doc({
          "blk-alert-0000002": { id: "blk-alert-0000002", type: "theme:example/alert", version: 1, attrs: { variant: '"><script>', text: "Hi" } },
        })}
      />,
    )
    expect(html).toContain("gl-alert--info")
    expect(html).not.toContain("<script>")
  })

  it("a block of a theme that isn't installed renders nothing, and is logged once", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {})
    const gone = doc({
      "blk-para-00000001": { id: "blk-para-00000001", type: "paragraph", version: 1, attrs: { text: "Before" } },
      "blk-gone-00000001": { id: "blk-gone-00000001", type: "theme:gone/widget", version: 3, attrs: { text: "secret" } },
    })
    const html = renderToStaticMarkup(<BlockRenderer doc={gone} />)
    renderToStaticMarkup(<BlockRenderer doc={gone} />)
    expect(html).toContain("Before")
    expect(html).not.toContain("secret")
    expect(warn.mock.calls.filter(([, fields]) => fields?.type === "theme:gone/widget")).toHaveLength(1)
    warn.mockRestore()
  })
})
