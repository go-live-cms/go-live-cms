import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import BlockRenderer from "../BlockRenderer"
import { columnImageSizes } from "./columns/ColumnsBlock"
import { headingAnchors } from "./utils/headingAnchors"
import { isFirstImageBlock } from "./utils/responsiveImage"

// Columns, buttons and the spacer on the public page (#426, "Published · layout"). The
// theme's own layout at 1280 and 375 is `themes/default/layoutBlocks.test.ts`.

const COLS = "blk-columns-00001"
const C1 = "blk-column-000001"
const C2 = "blk-column-000002"
const IMG = "blk-image-0000001"
const H = "blk-heading-00001"
const P = "blk-para-00000001"
const BTN = "blk-buttons-00001"
const SPC = "blk-spacer-000001"

function doc(columnsAttrs: Record<string, unknown> = {}, buttons?: unknown): BlockDocV1 {
  return {
    doc_version: 1,
    blocks_order: [COLS, BTN, SPC],
    blocks: {
      [COLS]: { id: COLS, type: "columns", version: 1, attrs: columnsAttrs, children: [C1, C2] },
      [C1]: { id: C1, type: "column", version: 1, attrs: {}, children: [IMG] },
      [C2]: { id: C2, type: "column", version: 1, attrs: {}, children: [H, P] },
      [IMG]: { id: IMG, type: "image", version: 2, attrs: { src: "/uploads/media/a.jpg", alt: "A", mediaId: 7 } },
      [H]: { id: H, type: "heading", version: 1, attrs: { level: 3, text: "Presence, quietly" } },
      [P]: { id: P, type: "paragraph", version: 1, attrs: { text: "Avatars in the top bar." } },
      [BTN]: {
        id: BTN,
        type: "buttons",
        version: 1,
        attrs:
          buttons === undefined
            ? {
                align: "center",
                text: "Read Log",
                pm: {
                  type: "buttons",
                  content: [
                    { type: "button", attrs: { href: "/guide" }, content: [{ type: "text", text: "Read" }] },
                    { type: "button", attrs: { href: "https://example.com/log", variant: "secondary" }, content: [{ type: "text", text: "Log" }] },
                  ],
                },
              }
            : (buttons as object),
      },
      [SPC]: { id: SPC, type: "spacer", version: 1, attrs: { size: "8" } },
    },
    media: { "7": { media_path: "/uploads/media/a.jpg", width: 1600, height: 1000, variants: { medium: { path: "/uploads/media/_variants/a/medium.jpg", width: 800, height: 500 } } } },
  } as unknown as BlockDocV1
}

const render = (d: BlockDocV1) => renderToStaticMarkup(<BlockRenderer doc={d} />)

describe("columns (#426)", () => {
  it("renders div.columns of div.column, in order, with the anchor on the row", () => {
    const html = render(doc())
    expect(html).toContain(`<div id="b-${COLS}" class="columns">`)
    expect(html).toMatch(/<div class="column"><img[^>]*><\/div><div class="column"><h3[^>]*>.*Presence, quietly.*<\/h3><p>Avatars in the top bar\.<\/p><\/div>/)
    expect(html).not.toContain(`id="b-${P}"`)
  })

  it("the classes for a split and a width", () => {
    expect(render(doc({ layout: "33-67", align: "wide" }))).toContain(`class="columns is-33-67 alignwide"`)
    expect(render(doc({ layout: "67-33", align: "full" }))).toContain(`class="columns is-67-33 alignfull"`)
    expect(render(doc({ layout: "50-50" }))).toContain(`class="columns"`)
  })

  it("three columns get their class, and a split doesn't apply to them", () => {
    const d = doc({ layout: "33-67" })
    d.blocks["c3-0000000001"] = { id: "c3-0000000001", type: "column", version: 1, attrs: {}, children: [] } as never
    d.blocks[COLS].children = [C1, C2, "c3-0000000001"]
    const html = render(d)
    expect(html).toContain(`class="columns is-3-columns"`)
    expect(html).not.toContain("is-33-67")
  })

  it("an image in a column says how wide it is", () => {
    expect(render(doc({ layout: "33-67" }))).toContain(`sizes="(max-width: 640px) 100vw, 227px"`)
    expect(render(doc({ layout: "67-33" }))).toContain(`sizes="(max-width: 640px) 100vw, 454px"`)
    expect(render(doc({ align: "wide" }))).toContain(`sizes="(max-width: 640px) 100vw, 480px"`)
    expect(columnImageSizes(0.5, "full")).toBe("(max-width: 640px) 100vw, 50vw")
  })

  it("a heading in a column gets an anchor, and the first image at any depth is the first", () => {
    const d = doc()
    expect(render(d)).toMatch(/<h3[^>]*id="presence-quietly"/)
    expect(headingAnchors(d).map((a) => a.id)).toEqual(["presence-quietly"])
    expect(isFirstImageBlock(d, IMG)).toBe(true)
  })
})

describe("buttons (#426)", () => {
  it("renders the theme's buttons, primary and secondary, centred", () => {
    const html = render(doc())
    expect(html).toContain(`<div id="b-${BTN}" class="buttons is-center">`)
    expect(html).toContain(`<a class="btn btn-primary" href="/guide">Read</a>`)
    expect(html).toContain(`<a class="btn btn-secondary" href="https://example.com/log">Log</a>`)
  })

  it("left is the default", () => {
    const html = render(doc({}, { pm: { type: "buttons", content: [{ type: "button", attrs: { href: "/a" }, content: [{ type: "text", text: "A" }] }] } }))
    expect(html).toContain(`<div id="b-${BTN}" class="buttons">`)
  })

  it.each(["javascript:alert(1)", "JAVASCRIPT:alert(1)", "java\tscript:alert(1)", "data:text/html,x"])("never renders %j as a link", (href) => {
    const html = render(doc({}, { pm: { type: "buttons", content: [{ type: "button", attrs: { href }, content: [{ type: "text", text: "A" }] }] } }))
    expect(html).not.toContain("javascript")
    expect(html).not.toContain("data:text")
    expect(html).not.toContain(`class="buttons`)
  })

  it("a button with no link or no label is left out; a row with none renders nothing", () => {
    const html = render(
      doc({}, { pm: { type: "buttons", content: [{ type: "button", attrs: {}, content: [{ type: "text", text: "No link" }] }, { type: "button", attrs: { href: "/x" } }, { type: "button", attrs: { href: "/y" }, content: [{ type: "text", text: "Kept" }] }] } }),
    )
    expect(html).not.toContain("No link")
    expect(html.match(/<a /g)).toHaveLength(1)
    expect(render(doc({}, { pm: { type: "buttons", content: [] } }))).not.toContain(`class="buttons`)
    expect(render(doc({}, {}))).not.toContain(`class="buttons`)
  })

  it("the label is escaped text", () => {
    const html = render(doc({}, { pm: { type: "buttons", content: [{ type: "button", attrs: { href: "/x" }, content: [{ type: "text", text: "<img onerror=x>" }] }] } }))
    expect(html).not.toContain("<img onerror")
  })
})

describe("spacer (#426)", () => {
  it("is empty space of a theme step, hidden from assistive technology", () => {
    const html = render(doc())
    expect(html).toContain(`<div id="b-${SPC}" class="spacer" aria-hidden="true" style="height:var(--space-8, 64px)"></div>`)
  })

  it("an unknown size is the default step, never a stored value", () => {
    const d = doc()
    ;(d.blocks[SPC].attrs as Record<string, unknown>).size = "400px;background:red"
    const html = render(d)
    expect(html).toContain("var(--space-7, 48px)")
    expect(html).not.toContain("background:red")
  })
})
