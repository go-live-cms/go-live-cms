import { describe, expect, it } from "vitest"
import { footnoteAnchorId, footnoteIndex, footnoteRefAnchorId, footnoteRefAttrs, normalizeFootnoteId, withFootnotesLast } from "./footnotes"
import type { BlockDocV1 } from "./index"

const ref = (footnoteId: string) => ({ type: "footnoteRef", attrs: { footnoteId } })
const text = (value: string) => ({ type: "text", text: value })
const paragraph = (id: string, ...content: unknown[]) => ({ id, type: "paragraph", version: 1, attrs: { pm: { type: "paragraph", content } } })
const note = (id: string, value = "Words") => ({ id, type: "footnote", version: 1, attrs: { pm: { type: "footnote", content: value ? [text(value)] : [] }, text: value } })
const list = (...children: string[]) => ({ id: "notes-0001", type: "footnotes", version: 1, attrs: {}, children })

function doc(order: string[], ...blocks: any[]): BlockDocV1 {
  return { doc_version: 1, blocks_order: order, blocks: Object.fromEntries(blocks.map((block) => [block.id, block])) } as BlockDocV1
}

describe("footnote ids", () => {
  it("are block ids, and nothing else", () => {
    expect(normalizeFootnoteId("3f2a1c9e-7b4d-4e21-9a10-1234567890ab")).toBe("3f2a1c9e-7b4d-4e21-9a10-1234567890ab")
    expect(normalizeFootnoteId("short")).toBeNull()
    expect(normalizeFootnoteId("<b>not-an-id</b>")).toBeNull()
    expect(normalizeFootnoteId(1234567890123)).toBeNull()
    expect(footnoteRefAttrs({ footnoteId: "note-000001", number: 4 })).toEqual({ footnoteId: "note-000001" })
    expect(footnoteRefAttrs({})).toBeNull()
  })
})

describe("footnoteIndex: numbers come from the references (#422)", () => {
  it("numbers notes by their first reference, whatever order the list has them in", () => {
    const first = ref("note-00002")
    const second = ref("note-00001")
    const d = doc(["para-00001", "notes-0001"], paragraph("para-00001", text("a"), first, text("b"), second), list("note-00001", "note-00002"), note("note-00001"), note("note-00002"))
    const index = footnoteIndex(d)
    expect(index.notes.map((n) => [n.id, n.number])).toEqual([
      ["note-00002", 1],
      ["note-00001", 2],
    ])
    expect(index.useOf(first)).toEqual({ id: "note-00002", number: 1, occurrence: 1 })
    expect(index.useOf(second)).toEqual({ id: "note-00001", number: 2, occurrence: 1 })
  })

  it("walks the reading order at any depth: a group, a list's items, a table's cells", () => {
    const inGroup = ref("note-00001")
    const inItem = ref("note-00002")
    const inCell = ref("note-00003")
    const d = doc(
      ["group-0001", "list-00001", "table-0001", "notes-0001"],
      { id: "group-0001", type: "group", version: 1, attrs: {}, children: ["para-00001"] },
      paragraph("para-00001", inGroup),
      { id: "list-00001", type: "bullet_list", version: 1, attrs: {}, children: ["item-00001"] },
      { id: "item-00001", type: "list_item", version: 1, attrs: { pm: { type: "listItem", content: [{ type: "paragraph", content: [inItem] }] } } },
      { id: "table-0001", type: "table", version: 1, attrs: { pm: { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [inCell] }] }] }] } } },
      list("note-00001", "note-00002", "note-00003"),
      note("note-00001"),
      note("note-00002"),
      note("note-00003"),
    )
    expect(footnoteIndex(d).notes.map((n) => n.number)).toEqual([1, 2, 3])
  })

  it("a stale reference (no such note) has no number and takes none", () => {
    const stale = ref("note-gone-01")
    const live = ref("note-00001")
    const d = doc(["para-00001", "notes-0001"], paragraph("para-00001", stale, live), list("note-00001"), note("note-00001"))
    const index = footnoteIndex(d)
    expect(index.useOf(stale)).toBeNull()
    expect(index.useOf(live)?.number).toBe(1)
  })

  it("an orphaned note (nothing refers to it) isn't listed and takes no number", () => {
    const live = ref("note-00002")
    const d = doc(["para-00001", "notes-0001"], paragraph("para-00001", live), list("note-00001", "note-00002"), note("note-00001"), note("note-00002"))
    expect(footnoteIndex(d).notes.map((n) => [n.id, n.number])).toEqual([["note-00002", 1]])
  })

  it("an empty note is left out with its references", () => {
    const empty = ref("note-00001")
    const live = ref("note-00002")
    const d = doc(["para-00001", "notes-0001"], paragraph("para-00001", empty, live), list("note-00001", "note-00002"), note("note-00001", ""), note("note-00002"))
    const index = footnoteIndex(d)
    expect(index.useOf(empty)).toBeNull()
    expect(index.useOf(live)?.number).toBe(1)
  })

  it("two references to one note share its number, each its own use", () => {
    const one = ref("note-00001")
    const two = ref("note-00001")
    const d = doc(["para-00001", "para-00002", "notes-0001"], paragraph("para-00001", one), paragraph("para-00002", two), list("note-00001"), note("note-00001"))
    const index = footnoteIndex(d)
    expect(index.notes).toHaveLength(1)
    expect(index.notes[0].uses).toBe(2)
    expect(index.useOf(one)).toMatchObject({ number: 1, occurrence: 1 })
    expect(index.useOf(two)).toMatchObject({ number: 1, occurrence: 2 })
  })

  it("a node the index didn't see still gets its number, but no use of its own", () => {
    const d = doc(["para-00001", "notes-0001"], paragraph("para-00001", ref("note-00001")), list("note-00001"), note("note-00001"))
    expect(footnoteIndex(d).useOf(ref("note-00001"))).toMatchObject({ number: 1, occurrence: null })
  })

  it("a list outside blocks_order, or no list, is nothing", () => {
    const d = doc(["para-00001"], paragraph("para-00001", ref("note-00001")), list("note-00001"), note("note-00001"))
    expect(footnoteIndex(d).notes).toEqual([])
    expect(footnoteIndex(null).notes).toEqual([])
  })

  it("a reference inside a note isn't one", () => {
    const inNote = { id: "note-00001", type: "footnote", version: 1, attrs: { pm: { type: "footnote", content: [text("x"), ref("note-00001")] } } }
    const d = doc(["para-00001", "notes-0001"], paragraph("para-00001", text("no refs")), list("note-00001"), inNote)
    expect(footnoteIndex(d).notes).toEqual([])
  })
})

describe("anchors", () => {
  it("are the board's, with a suffix for a note's later uses", () => {
    expect(footnoteAnchorId(3)).toBe("fn-3")
    expect(footnoteRefAnchorId(3, 1)).toBe("ref-3")
    expect(footnoteRefAnchorId(3, 2)).toBe("ref-3-2")
  })
})

describe("withFootnotesLast", () => {
  const blocks = { a: { type: "paragraph" }, b: { type: "paragraph" }, n: { type: "footnotes" } }
  it("moves the list after a block that landed behind it", () => {
    expect(withFootnotesLast(["n", "a", "b"], blocks)).toEqual(["a", "b", "n"])
  })
  it("returns the same array when there's nothing to do", () => {
    const fine = ["a", "n"]
    expect(withFootnotesLast(fine, blocks)).toBe(fine)
    const none = ["a", "b"]
    expect(withFootnotesLast(none, blocks)).toBe(none)
  })
})
