import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import BlockRenderer from "../../BlockRenderer"
import { headingAnchors } from "../utils/headingAnchors"

const render = (d: BlockDocV1) => renderToStaticMarkup(<BlockRenderer doc={d} />)

const ref = (footnoteId: string) => ({ type: "footnoteRef", attrs: { footnoteId } })
const text = (value: string) => ({ type: "text", text: value })
const paragraph = (id: string, ...content: unknown[]) => ({ id, type: "paragraph", version: 1, attrs: { pm: { type: "paragraph", content } } })
const note = (id: string, value: string) => ({ id, type: "footnote", version: 1, attrs: { pm: { type: "footnote", content: value ? [text(value)] : [] }, text: value } })
const list = (...children: string[]) => ({ id: "notes-0001", type: "footnotes", version: 1, attrs: {}, children })

function doc(order: string[], ...blocks: any[]): BlockDocV1 {
  return { doc_version: 1, blocks_order: order, blocks: Object.fromEntries(blocks.map((block) => [block.id, block])) } as BlockDocV1
}

const two = () =>
  doc(
    ["para-00001", "notes-0001"],
    paragraph("para-00001", text("One"), ref("note-00001"), text(" and two"), ref("note-00002"), text(".")),
    list("note-00001", "note-00002"),
    note("note-00001", "Only while open."),
    note("note-00002", "From eight colours."),
  )

describe("the published footnotes (#422, the canvas's Published · text)", () => {
  it("renders the board's markup, with working anchors both ways", () => {
    const html = render(two())
    expect(html).toContain('<sup><a class="fn-ref" href="#fn-1" id="ref-1" aria-label="Footnote 1">1</a></sup>')
    expect(html).toContain('<sup><a class="fn-ref" href="#fn-2" id="ref-2" aria-label="Footnote 2">2</a></sup>')
    expect(html).toContain('<section class="footnotes" id="b-notes-0001" aria-labelledby="fn-title"><h2 id="fn-title">Footnotes</h2><ol>')
    expect(html).toContain('<li id="fn-1">Only while open.<a class="fn-back" href="#ref-1" aria-label="Back to reference 1">↩</a></li>')
    expect(html).toContain('<li id="fn-2">From eight colours.<a class="fn-back" href="#ref-2" aria-label="Back to reference 2">↩</a></li>')
  })

  it("lists notes by reference order, not list order", () => {
    const d = two()
    ;(d.blocks["notes-0001"] as any).children = ["note-00002", "note-00001"]
    ;(d.blocks["para-00001"].attrs as any).pm.content = [ref("note-00002"), ref("note-00001")]
    const html = render(d)
    expect(html.indexOf('id="fn-1">From eight colours.')).toBeGreaterThan(-1)
    expect(html.indexOf('id="fn-2">Only while open.')).toBeGreaterThan(html.indexOf('id="fn-1"'))
  })

  it("keeps every link resolving: each href's target exists on the page", () => {
    const html = render(two())
    const hrefs = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1])
    expect(hrefs.length).toBe(4)
    for (const target of hrefs) expect(html).toContain(`id="${target}"`)
  })

  it("a stale reference (its note is gone) renders nothing", () => {
    const d = doc(["para-00001", "notes-0001"], paragraph("para-00001", text("Hi"), ref("note-gone-01"), ref("note-00001")), list("note-00001"), note("note-00001", "Kept"))
    const html = render(d)
    expect(html).not.toContain("note-gone")
    expect(html.match(/fn-ref/g)).toHaveLength(1)
    expect(html).toContain('href="#fn-1"')
  })

  it("a stale reference with no list at all renders just the text", () => {
    const html = render(doc(["para-00001"], paragraph("para-00001", text("Hi"), ref("note-00001"))))
    expect(html).toContain("<p")
    expect(html).toContain("Hi")
    expect(html).not.toContain("fn-")
  })

  it("an orphaned note (no reference) isn't on the page, and the others keep their numbers", () => {
    const d = doc(["para-00001", "notes-0001"], paragraph("para-00001", ref("note-00002")), list("note-00001", "note-00002"), note("note-00001", "Orphan"), note("note-00002", "Live"))
    const html = render(d)
    expect(html).not.toContain("Orphan")
    expect(html).toContain('<li id="fn-1">Live')
  })

  it("no section at all when every note is an orphan", () => {
    const html = render(doc(["para-00001", "notes-0001"], paragraph("para-00001", text("x")), list("note-00001"), note("note-00001", "Orphan")))
    expect(html).not.toContain('class="footnotes"')
  })

  it("an empty note is left out with its reference", () => {
    const html = render(doc(["para-00001", "notes-0001"], paragraph("para-00001", ref("note-00001")), list("note-00001"), note("note-00001", "")))
    expect(html).not.toContain("fn-ref")
    expect(html).not.toContain('class="footnotes"')
  })

  it("two references to one note share its number, with an anchor and a back link each", () => {
    const d = doc(["para-00001", "para-00002", "notes-0001"], paragraph("para-00001", ref("note-00001")), paragraph("para-00002", ref("note-00001")), list("note-00001"), note("note-00001", "Shared"))
    const html = render(d)
    expect(html).toContain('id="ref-1"')
    expect(html).toContain('id="ref-1-2"')
    expect(html).toContain('href="#ref-1" aria-label="Back to reference 1"')
    expect(html).toContain('href="#ref-1-2" aria-label="Back to reference 1, use 2">↩<sup>2</sup></a>')
    expect(html.match(/id="fn-\d+"/g)).toHaveLength(1)
  })

  it("marks and inline nodes in a note render", () => {
    const rich = { id: "note-00001", type: "footnote", version: 1, attrs: { pm: { type: "footnote", content: [text("A "), { type: "text", text: "bold", marks: [{ type: "bold" }] }] } } }
    const html = render(doc(["para-00001", "notes-0001"], paragraph("para-00001", ref("note-00001")), list("note-00001"), rich))
    expect(html).toContain("A <strong>bold</strong>")
  })

  it("a reference in a table cell, a list item or a group is numbered in reading order", () => {
    const d = doc(
      ["group-0001", "table-0001", "notes-0001"],
      { id: "group-0001", type: "group", version: 1, attrs: {}, children: ["para-00001"] },
      paragraph("para-00001", ref("note-00001")),
      { id: "table-0001", type: "table", version: 1, attrs: { pm: { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [ref("note-00002")] }] }] }] } } },
      list("note-00001", "note-00002"),
      note("note-00001", "A"),
      note("note-00002", "B"),
    )
    const html = render(d)
    expect(html).toContain('href="#fn-1"')
    expect(html).toContain('id="ref-2"')
    expect(html).toContain('<li id="fn-2">B')
  })

  it("a reference the page doesn't draw gets no number, so no back link dangles", () => {
    const nested = { type: "listItem", content: [{ type: "paragraph", content: [text("top")] }, { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [ref("note-00001")] }] }] }] }
    const list2 = { id: "list-00001", type: "bullet_list", version: 1, attrs: {}, children: ["item-00001"] }
    const item = { id: "item-00001", type: "list_item", version: 1, attrs: { pm: nested } }
    const html = render(doc(["list-00001", "notes-0001"], list2, item, list("note-00001"), note("note-00001", "Hidden")))
    expect(html).not.toContain("fn-back")
    for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) expect(html).toContain(`id="${target}"`)
  })

  it("a block of a removed theme holds no number either", () => {
    const removed = { id: "gone-00001", type: "theme:gone/block", version: 1, attrs: { pm: { type: "theme:gone/block", content: [ref("note-00001")] } } }
    const html = render(doc(["gone-00001", "para-00001", "notes-0001"], removed, paragraph("para-00001", ref("note-00002")), list("note-00001", "note-00002"), note("note-00001", "A"), note("note-00002", "B")))
    expect(html).toContain('<li id="fn-1">B')
    expect(html).not.toContain(">A<")
  })

  describe("a reference in a cover or media & text (#427)", () => {
    const withCover = (type: "cover" | "media_text", extra: Record<string, unknown> = {}) => {
      const holder = { id: "cover-0001", type, version: 1, attrs: { mediaId: 7 }, children: ["para-00001"] }
      const d = doc(["cover-0001", "para-00002", "notes-0001"], holder, paragraph("para-00001", ref("note-00001")), paragraph("para-00002", ref("note-00002")), list("note-00001", "note-00002"), note("note-00001", "In the cover"), note("note-00002", "After it"))
      return { ...d, ...extra } as BlockDocV1
    }

    it.each(["cover", "media_text"] as const)("%s: numbered in reading order while its image is there", (type) => {
      const html = render(withCover(type))
      expect(html).toContain('<li id="fn-1">In the cover')
      expect(html).toContain('<li id="fn-2">After it')
    })

    it.each(["cover", "media_text"] as const)("%s: its image deleted, it holds no number and no back link dangles", (type) => {
      const html = render(withCover(type, { media_missing: [7] }))
      expect(html).not.toContain("In the cover")
      expect(html).toContain('<li id="fn-1">After it')
      for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) expect(html).toContain(`id="${target}"`)
    })
  })

  it("trims a blank last paragraph before the list too", () => {
    const d = doc(["para-00001", "para-blank1", "notes-0001"], paragraph("para-00001", ref("note-00001")), paragraph("para-blank1"), list("note-00001"), note("note-00001", "N"))
    expect(render(d)).not.toContain('id="b-para-blank1"')
  })
})

describe("heading anchors stay clear of the footnotes' (#422)", () => {
  const heading = (id: string, value: string) => ({ id, type: "heading", version: 1, attrs: { level: 2, text: value } })

  it("a heading slugged ref-1 or fn-1 moves aside in a post with footnotes", () => {
    const d = doc(["head-00001", "head-00002", "head-00003", "notes-0001"], heading("head-00001", "Ref 1"), heading("head-00002", "Fn 2"), heading("head-00003", "Fn title"), list("note-00001"), note("note-00001", "x"))
    const ids = headingAnchors(d).map((h) => h.id)
    expect(ids).not.toContain("ref-1")
    expect(ids).not.toContain("fn-2")
    expect(ids).not.toContain("fn-title")
  })

  it("keeps the old id in a post without", () => {
    expect(headingAnchors(doc(["head-00001"], heading("head-00001", "Ref 1"))).map((h) => h.id)).toEqual(["ref-1"])
  })
})
