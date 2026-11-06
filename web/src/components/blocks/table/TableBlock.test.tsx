import React from "react"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import BlockRenderer from "../../BlockRenderer"

// The table on the public page (#420): `figure > div.table-scroll[role=region]
// [tabindex=0][aria-labelledby] > table` with `th scope` and `figcaption`, and the default
// theme's rules that keep a wide table scrolling inside its own box on a phone.

const TABLE = "blk-0420-table-000001"
const GROUP = "blk-0420-group-000001"

const p = (text: string, marks?: string[]) => ({
  type: "paragraph",
  content: [{ type: "text", text, ...(marks ? { marks: marks.map((type) => ({ type })) } : {}) }],
})
const cell = (texts: string[] | string, attrs?: Record<string, number>) => ({
  type: "tableCell",
  ...(attrs ? { attrs } : {}),
  content: (Array.isArray(texts) ? texts : [texts]).map((text) => p(text)),
})
const row = (...cells: any[]) => ({ type: "tableRow", content: cells })

function doc(attrs: Record<string, unknown> = {}, nested = false): BlockDocV1 {
  const table = {
    id: TABLE,
    type: "table",
    version: 1,
    attrs: {
      pm: {
        type: "table",
        content: [
          row(cell("Role"), cell("Write posts"), cell("Publish")),
          row(cell("Admin"), cell("Everything", { colspan: 2 })),
          row(cell("Contributor"), cell(["Their own", "drafts"]), cell("No")),
        ],
      },
      headerRow: true,
      caption: [{ type: "text", text: "Who can do " }, { type: "text", text: "what", marks: [{ type: "bold" }] }],
      ...attrs,
    },
  } as const
  return nested
    ? { doc_version: 1, blocks_order: [GROUP], blocks: { [GROUP]: { id: GROUP, type: "group", version: 1, attrs: {}, children: [TABLE] }, [TABLE]: table as any } }
    : { doc_version: 1, blocks_order: [TABLE], blocks: { [TABLE]: table as any } }
}

const render = (d: BlockDocV1) => {
  const host = document.createElement("div")
  host.innerHTML = renderToStaticMarkup(<BlockRenderer doc={d} />)
  return host
}

describe("the table on the public page (#420)", () => {
  it("renders figure > div.table-scroll (a focusable region named by the caption) > table, and the figcaption", () => {
    const host = render(doc())
    const figure = host.querySelector("figure")!
    expect(figure.id).toBe(`b-${TABLE}`)
    const region = figure.querySelector(":scope > div.table-scroll")!
    expect(region.getAttribute("role")).toBe("region")
    expect(region.getAttribute("tabindex")).toBe("0")
    const caption = figure.querySelector(":scope > figcaption")!
    expect(caption.innerHTML).toBe("Who can do <strong>what</strong>")
    expect(caption.id).toBe(`b-${TABLE}-caption`)
    expect(region.getAttribute("aria-labelledby")).toBe(caption.id)
    expect(region.hasAttribute("aria-label")).toBe(false)
    expect(region.querySelector(":scope > table")).not.toBeNull()
  })

  it("makes the header row a thead of th scope=col, and the rest td, with spans and paragraphs", () => {
    const table = render(doc()).querySelector("table")!
    const head = Array.from(table.querySelectorAll("thead th")).map((th) => [th.textContent, th.getAttribute("scope")])
    expect(head).toEqual([
      ["Role", "col"],
      ["Write posts", "col"],
      ["Publish", "col"],
    ])
    const rows = Array.from(table.querySelectorAll("tbody tr")).map((tr) => Array.from(tr.children).map((c) => [c.tagName, c.innerHTML, c.getAttribute("colspan")]))
    expect(rows).toEqual([
      [
        ["TD", "Admin", null],
        ["TD", "Everything", "2"],
      ],
      [
        ["TD", "Contributor", null],
        ["TD", "Their own<br>drafts", null],
        ["TD", "No", null],
      ],
    ])
  })

  it("without a header row every row is in the tbody; without a caption the region is named Table", () => {
    const host = render(doc({ headerRow: undefined, caption: undefined }))
    expect(host.querySelector("thead")).toBeNull()
    expect(host.querySelectorAll("tbody tr")).toHaveLength(3)
    expect(host.querySelector("figcaption")).toBeNull()
    const region = host.querySelector(".table-scroll")!
    expect(region.getAttribute("aria-label")).toBe("Table")
    expect(region.hasAttribute("aria-labelledby")).toBe(false)
  })

  it("a header cell spanning columns scopes its colgroup, and never spans rows into the body", () => {
    const d = doc()
    ;(d.blocks[TABLE].attrs as any).pm.content[0] = row(cell("People", { colspan: 2, rowspan: 2 }), cell("Publish"))
    const ths = Array.from(render(d).querySelectorAll("thead th"))
    expect(ths.map((th) => [th.getAttribute("scope"), th.getAttribute("colspan"), th.getAttribute("rowspan")])).toEqual([
      ["colgroup", "2", null],
      ["col", null, null],
    ])
  })

  it("inside a group, still has its caption id (from the block id) though it has no anchor", () => {
    const host = render(doc({}, true))
    const region = host.querySelector(".group .table-scroll")!
    expect(host.querySelector(".group figure")!.id).toBe("")
    expect(region.getAttribute("aria-labelledby")).toBe(`b-${TABLE}-caption`)
    expect(host.querySelector(`#b-${TABLE}-caption`)!.textContent).toBe("Who can do what")
  })

  it("renders only what a table may hold: no rows renders nothing, other nodes in a cell are left out", () => {
    expect(render(doc({ pm: { type: "table", content: [] } })).innerHTML).not.toContain("<table")
    const d = doc()
    ;(d.blocks[TABLE].attrs as any).pm.content[1].content[0].content = [{ type: "image", attrs: { src: "javascript:x" } }, p("Admin")]
    const table = render(d).querySelector("table")!
    expect(table.querySelector("img")).toBeNull()
    expect(table.querySelector("tbody td")!.textContent).toBe("Admin")
  })
})

describe("the default theme's table (#420): a wide table scrolls in its own box at 375px", () => {
  const css = readFileSync(resolve(__dirname, "../../../../themes/default/styles/theme.css"), "utf8")
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`)
    expect(at, selector).toBeGreaterThan(-1)
    return css.slice(at, css.indexOf("}", at))
  }

  it("scrolls sideways inside .table-scroll, and the table keeps a min-width wider than a phone", () => {
    expect(rule(".prose .table-scroll")).toMatch(/overflow-x:\s*auto/)
    const minWidth = /min-width:\s*([\d.]+)rem/.exec(rule(".prose .table-scroll table"))
    expect(minWidth).not.toBeNull()
    // 375px minus the 16px gutters is ~343px; a 34rem table (544px) scrolls.
    expect(Number(minWidth![1]) * 16).toBeGreaterThan(375)
    // Nothing clips the box itself (it never widens the page: the table scrolls in it).
    expect(rule(".prose .table-scroll")).not.toMatch(/overflow:\s*visible|white-space:\s*nowrap/)
  })

  it("styles the header row from the theme's tokens, so light and dark both follow them", () => {
    const head = rule(".prose .table-scroll thead th")
    expect(head).toMatch(/background:\s*var\(--color-surface\)/)
    expect(head).toMatch(/color:\s*var\(--color-secondary\)/)
    expect(rule(".prose .table-scroll :is(th, td)")).toMatch(/border-bottom:\s*1px solid var\(--color-border\)/)
  })
})
