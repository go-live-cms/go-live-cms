import { describe, expect, it, vi } from "vitest"
import * as Y from "yjs"
import { validateBlockDoc, type BlockDocV1 } from "../blocks-spec"
import { blockDocToPMWithReport, pmToBlockDoc, restoreDroppedBlocks } from "./blockBridge"
import { fragmentToBlockDoc, repairFootnotesFragment, seedFragment } from "./fragmentBridge"
import { getCoreSchema } from "./schema"

const schema = getCoreSchema()

const P = "para-footnote-01"
const LIST = "list-footnote-01"
const NOTE = "note-footnote-01"
const NOTE2 = "note-footnote-02"

const ref = (footnoteId: string) => ({ type: "footnoteRef", attrs: { footnoteId } })

const stored: BlockDocV1 = {
  doc_version: 1,
  blocks_order: [P, LIST],
  blocks: {
    [P]: { id: P, type: "paragraph", version: 1, attrs: { pm: { type: "paragraph", attrs: { textAlign: null, "data-block-id": P, blockColor: undefined }, content: [{ type: "text", text: "Claim" }, ref(NOTE)] }, text: "Claim" } },
    [LIST]: { id: LIST, type: "footnotes", version: 1, attrs: {}, children: [NOTE, NOTE2] },
    [NOTE]: { id: NOTE, type: "footnote", version: 1, attrs: { pm: { type: "footnote", attrs: { "data-block-id": NOTE }, content: [{ type: "text", text: "A " }, { type: "text", text: "source", marks: [{ type: "bold" }] }] }, text: "A source" } },
    [NOTE2]: { id: NOTE2, type: "footnote", version: 1, attrs: { pm: { type: "footnote", attrs: { "data-block-id": NOTE2 }, content: [{ type: "text", text: "Orphan" }] }, text: "Orphan" } },
  },
} as BlockDocV1

describe("footnotes through the bridge (#422)", () => {
  it("round-trips: the reference in its text, the list last, an unreferenced note kept", () => {
    const { node, dropped } = blockDocToPMWithReport(stored, schema)
    expect(dropped).toEqual([])
    node.check()
    expect(node.child(0).child(1).type.name).toBe("footnoteRef")
    expect(node.child(0).child(1).attrs).toEqual({ footnoteId: NOTE })
    expect(node.child(1).type.name).toBe("footnotes")
    expect(node.child(1).childCount).toBe(2)

    const doc = pmToBlockDoc(node)
    expect(doc.blocks_order).toEqual([P, LIST])
    expect(doc.blocks[LIST]).toEqual({ id: LIST, type: "footnotes", version: 1, attrs: {}, children: [NOTE, NOTE2] })
    expect((doc.blocks[NOTE].attrs as any).text).toBe("A source")
    expect((doc.blocks[NOTE].attrs as any).pm.content[1].marks).toEqual([{ type: "bold" }])
    expect((doc.blocks[P].attrs as any).pm.content[1]).toEqual(ref(NOTE))
    // A reference has no text: a block's `text` (search, excerpts) reads as the author wrote it.
    expect((doc.blocks[P].attrs as any).text).toBe("Claim")
    expect(() => validateBlockDoc(doc)).not.toThrow()
  })

  it("round-trips through the fragment", () => {
    const fragment = new Y.Doc().getXmlFragment("default")
    expect(seedFragment(stored, fragment, schema).entries).toEqual([])
    const doc = fragmentToBlockDoc(fragment, schema)
    expect(doc.blocks_order).toEqual([P, LIST])
    expect((doc.blocks[P].attrs as any).pm.content[1]).toEqual(ref(NOTE))
    expect(doc.blocks[LIST].children).toEqual([NOTE, NOTE2])
  })

  it("a note the schema can't build is hidden and kept; its list stays", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const broken = structuredClone(stored)
    ;(broken.blocks[NOTE2].attrs as any).pm.content = [{ type: "paragraph" }]
    const { node, dropped } = blockDocToPMWithReport(broken, schema)
    expect(dropped).toEqual([{ id: NOTE2, parentId: LIST, afterId: NOTE }])
    expect(node.child(1).childCount).toBe(1)
    const restored = restoreDroppedBlocks(pmToBlockDoc(node), broken, dropped)
    expect(restored.blocks[LIST].children).toEqual([NOTE, NOTE2])
    vi.restoreAllMocks()
  })

  it("a list whose every note is hidden gets an empty one, with an id that doesn't change", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const broken = structuredClone(stored)
    ;(broken.blocks[NOTE].attrs as any).pm.content = [{ type: "paragraph" }]
    ;(broken.blocks[NOTE2].attrs as any).pm.content = [{ type: "paragraph" }]
    const first = blockDocToPMWithReport(broken, schema)
    first.node.check()
    expect(first.node.child(1).child(0).attrs["data-block-id"]).toBe(`${LIST}-footnote-note`)
    expect(blockDocToPMWithReport(broken, schema).node.child(1).child(0).attrs["data-block-id"]).toBe(`${LIST}-footnote-note`)
    vi.restoreAllMocks()
  })

  it("a reference inside a stored note can't be built, so the note is hidden rather than nested", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const broken = structuredClone(stored)
    ;(broken.blocks[NOTE].attrs as any).pm.content = [ref(NOTE2)]
    expect(blockDocToPMWithReport(broken, schema).dropped.map((d) => d.id)).toEqual([NOTE])
    vi.restoreAllMocks()
  })

  it("a hidden block going back never lands after the list", () => {
    const source: BlockDocV1 = {
      doc_version: 1,
      blocks_order: ["gone-anchor-1", "hidden-block1"],
      blocks: { "hidden-block1": { id: "hidden-block1", type: "paragraph", version: 1, attrs: { text: "kept" } } },
    } as BlockDocV1
    const restored = restoreDroppedBlocks(stored, source, [{ id: "hidden-block1", parentId: null, afterId: "gone-anchor-1" }])
    expect(restored.blocks_order).toEqual([P, "hidden-block1", LIST])
    expect(() => validateBlockDoc(restored)).not.toThrow()
  })

  it("validates the rules the API enforces", () => {
    const twoLists = structuredClone(stored)
    twoLists.blocks["list-footnote-02"] = { id: "list-footnote-02", type: "footnotes", version: 1, attrs: {}, children: [NOTE2] } as any
    twoLists.blocks[LIST].children = [NOTE]
    twoLists.blocks_order = [P, LIST, "list-footnote-02"]
    expect(() => validateBlockDoc(twoLists)).toThrow(/last block/)

    const notLast = structuredClone(stored)
    notLast.blocks_order = [LIST, P]
    expect(() => validateBlockDoc(notLast)).toThrow(/last block/)
  })
})

describe("repairFootnotesFragment (#422)", () => {
  const element = (name: string, id: string, ...children: (Y.XmlElement | Y.XmlText)[]) => {
    const node = new Y.XmlElement(name)
    node.setAttribute("data-block-id", id)
    if (children.length) node.insert(0, children)
    return node
  }
  const note = (id: string, value: string) => {
    const text = new Y.XmlText()
    text.insert(0, value)
    return element("footnote", id, text)
  }
  const paragraph = (id: string) => element("paragraph", id)
  const setup = (...nodes: Y.XmlElement[]) => {
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment("default")
    fragment.insert(0, nodes)
    return fragment
  }
  const names = (fragment: Y.XmlFragment) => fragment.toArray().map((n) => (n as Y.XmlElement).nodeName)
  const noteIds = (list: unknown) => (list as Y.XmlElement).toArray().map((n) => (n as Y.XmlElement).getAttribute("data-block-id"))

  it("does nothing to one list, last", () => {
    const fragment = setup(paragraph("para-000001"), element("footnotes", "list-000001", note("note-000001", "x")))
    expect(repairFootnotesFragment(fragment)).toBe(0)
  })

  it("does nothing without a list", () => {
    expect(repairFootnotesFragment(setup(paragraph("para-000001")))).toBe(0)
  })

  it("merges two lists into the first, notes and their text kept, in one transaction", () => {
    const fragment = setup(
      paragraph("para-000001"),
      element("footnotes", "list-000001", note("note-000001", "first")),
      element("footnotes", "list-000002", note("note-000002", "second")),
    )
    let transactions = 0
    fragment.doc!.on("afterTransaction", () => transactions++)
    expect(repairFootnotesFragment(fragment)).toBe(2)
    expect(transactions).toBe(1)
    expect(names(fragment)).toEqual(["paragraph", "footnotes"])
    expect(noteIds(fragment.get(1))).toEqual(["note-000001", "note-000002"])
    expect(fragment.get(1).toString()).toContain("second")
  })

  it("moves a list with a block after it to the end", () => {
    const fragment = setup(element("footnotes", "list-000001", note("note-000001", "first")), paragraph("para-000001"))
    expect(repairFootnotesFragment(fragment)).toBe(1)
    expect(names(fragment)).toEqual(["paragraph", "footnotes"])
    expect((fragment.get(1) as Y.XmlElement).getAttribute("data-block-id")).toBe("list-000001")
    expect(fragment.get(1).toString()).toContain("first")
  })

  it("a note in both lists once (two people merging the same copy) is kept once", () => {
    const fragment = setup(element("footnotes", "list-000001", note("note-000001", "a")), element("footnotes", "list-000002", note("note-000001", "a")))
    repairFootnotesFragment(fragment)
    expect(noteIds(fragment.get(0))).toEqual(["note-000001"])
  })

  it("converges: a second run changes nothing", () => {
    const fragment = setup(element("footnotes", "list-000001", note("note-000001", "a")), paragraph("para-000001"), element("footnotes", "list-000002", note("note-000002", "b")))
    expect(repairFootnotesFragment(fragment)).toBe(2)
    expect(repairFootnotesFragment(fragment)).toBe(0)
  })
})
