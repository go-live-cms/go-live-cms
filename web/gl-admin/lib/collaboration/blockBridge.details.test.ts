import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as Y from "yjs"
import { validateBlockDoc, type BlockDocV1 } from "../blocks-spec"
import { blockDocToPMWithReport, pmToBlockDoc } from "./blockBridge"
import { fragmentToBlockDoc, seedFragment, stampFragmentBlockIds, type UnconvertibleBlock } from "./fragmentBridge"
import { getInstalledCollabSchema } from "../theme-blocks/collabSchema"
import { canonical } from "./fragmentBridge.fixtures"

// Details (#421, design 2.4): a container whose summary is a part (`detailsSummary`, rich
// text) stored as `attrs.summary` runs and `attrs.text`, never a block, plus `open`.
// Round trips through the bridge and the Yjs fragment, at the top and in a group; a bad
// child is dropped on its own; ids for its children, never for the summary; the store's
// fallback per child; and the Zod schema.

const schema = getInstalledCollabSchema()

const D1 = "blk-details-0001"
const D2 = "blk-details-0002"
const G1 = "blk-group-000001"
const P1 = "blk-para-0000001"
const P2 = "blk-para-0000002"
const IMG = "blk-image-000001"
const TABLE = "blk-table-000001"
const CODE = "blk-code-0000001"

const SUMMARY = [
  { type: "text", text: "Can " },
  { type: "text", text: "contributors", marks: [{ type: "bold" }] },
  { type: "text", text: " publish?" },
] as const

function detailsDoc(): BlockDocV1 {
  return {
    doc_version: 1,
    blocks_order: [D1, G1],
    blocks: {
      [D1]: { id: D1, type: "details", version: 1, attrs: { summary: [...SUMMARY], text: "Can contributors publish?", open: true }, children: [P1, IMG, TABLE] },
      [P1]: { id: P1, type: "paragraph", version: 1, attrs: { text: "No. An editor publishes." } },
      [IMG]: { id: IMG, type: "image", version: 2, attrs: { src: "/uploads/a.png", alt: "A", mediaId: 7 } },
      [TABLE]: {
        id: TABLE,
        type: "table",
        version: 1,
        attrs: { pm: { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "Cell" }] }] }] }] }, text: "Cell" },
      },
      [G1]: { id: G1, type: "group", version: 1, attrs: {}, children: [D2] },
      [D2]: { id: D2, type: "details", version: 1, attrs: {}, children: [P2] },
      [P2]: { id: P2, type: "paragraph", version: 1, attrs: { text: "In a group" } },
    },
  }
}

function seed(doc: BlockDocV1) {
  const ydoc = new Y.Doc()
  const fragment = ydoc.getXmlFragment("default")
  const dropped = seedFragment(doc, fragment, schema)
  return { ydoc, fragment, dropped }
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe("details round-trip (#421)", () => {
  it("Block Spec → PM → Yjs → Block Spec is unchanged, at the top and in a group", () => {
    const doc = canonical(detailsDoc(), schema)
    expect(doc.blocks_order).toEqual([D1, G1])
    expect(doc.blocks[D1]).toEqual(detailsDoc().blocks[D1])
    expect(doc.blocks[G1].children).toEqual([D2])
    expect(doc.blocks[D2]).toEqual({ id: D2, type: "details", version: 1, attrs: {}, children: [P2] })
    expect(() => validateBlockDoc(doc)).not.toThrow()

    const { fragment, dropped } = seed(doc)
    expect(dropped.entries).toEqual([])
    const stored = fragmentToBlockDoc(fragment, schema)
    expect(stored).toEqual(doc)
    expect(fragmentToBlockDoc(seed(stored).fragment, schema)).toEqual(doc)
  })

  it("in PM the summary is the first child, with its marks, and the blocks follow", () => {
    const { node } = blockDocToPMWithReport(detailsDoc(), schema)
    expect(() => node.check()).not.toThrow()
    const details = node.firstChild!
    expect(details.type.name).toBe("details")
    expect(details.attrs.open).toBe(true)
    expect(details.child(0).type.name).toBe("detailsSummary")
    expect(details.child(0).textContent).toBe("Can contributors publish?")
    expect(details.child(0).child(1).marks.map((m) => m.type.name)).toEqual(["bold"])
    expect(details.child(0).attrs["data-block-id"]).toBeUndefined()
    expect([1, 2, 3].map((i) => details.child(i).attrs["data-block-id"])).toEqual([P1, IMG, TABLE])
  })

  it("the summary is never a block: no id, not in blocks, not in children", () => {
    const out = pmToBlockDoc(blockDocToPMWithReport(detailsDoc(), schema).node)
    expect(Object.keys(out.blocks).sort()).toEqual([D1, D2, G1, IMG, P1, P2, TABLE].sort())
    expect(out.blocks[D1].children).toEqual([P1, IMG, TABLE])
    expect(Object.values(out.blocks).some((b) => (b.type as string) === "detailsSummary")).toBe(false)
  })

  it("defaults are left out: a closed details with an empty summary stores only its children", () => {
    const doc = detailsDoc()
    doc.blocks[D1] = { ...doc.blocks[D1], attrs: { open: false as unknown as true } }
    const out = pmToBlockDoc(blockDocToPMWithReport(doc, schema).node)
    expect(out.blocks[D1].attrs).toEqual({})
    // An open that isn't `true` reads as closed.
    const odd = detailsDoc()
    ;(odd.blocks[D1].attrs as any).open = "yes"
    expect(blockDocToPMWithReport(odd, schema).node.firstChild!.attrs.open).toBe(false)
  })

  it("a summary's runs keep only the caption marks (a bad mark costs the mark, not the details)", () => {
    const doc = detailsDoc()
    ;(doc.blocks[D1].attrs as any).summary = [
      { type: "text", text: "Hi", marks: [{ type: "code" }, { type: "italic" }] },
      { type: "image" },
      { type: "text", text: "" },
    ]
    const { node, dropped } = blockDocToPMWithReport(doc, schema)
    expect(dropped).toEqual([])
    const summary = node.firstChild!.child(0)
    expect(summary.textContent).toBe("Hi")
    expect(summary.firstChild!.marks.map((m) => m.type.name)).toEqual(["italic"])
    expect(pmToBlockDoc(node).blocks[D1].attrs).toMatchObject({ summary: [{ type: "text", text: "Hi", marks: [{ type: "italic" }] }], text: "Hi" })
  })

  it("bold, italic and link survive Block Spec → PM → Yjs → Block Spec; #418's marks don't enter a summary", () => {
    const link = { type: "link", attrs: { href: "https://example.com/roles" } }
    const doc = detailsDoc()
    ;(doc.blocks[D1].attrs as any).summary = [
      { type: "text", text: "b", marks: [{ type: "bold" }] },
      { type: "text", text: "i", marks: [{ type: "italic" }] },
      { type: "text", text: "l", marks: [link] },
      { type: "text", text: "h", marks: [{ type: "highlight" }] },
      { type: "text", text: "s", marks: [{ type: "superscript" }] },
    ]
    const pm = blockDocToPMWithReport(doc, schema).node
    const summary = pm.firstChild!.child(0)
    expect(summary.textContent).toBe("bilhs")
    expect(summary.child(0).marks.map((m) => m.type.name)).toEqual(["bold"])
    expect(summary.child(1).marks.map((m) => m.type.name)).toEqual(["italic"])
    expect(summary.child(2).marks.map((m) => m.type.name)).toEqual(["link"])
    expect(summary.child(2).marks[0].attrs.href).toBe("https://example.com/roles")
    // The last two runs lost their marks (Yjs joins them into one plain run below).
    expect([summary.child(3).marks, summary.child(4).marks]).toEqual([[], []])

    const stored = fragmentToBlockDoc(seed(canonical(doc, schema)).fragment, schema)
    const runs = stored.blocks[D1].attrs.summary as any[]
    expect(runs.map((r) => r.text)).toEqual(["b", "i", "l", "hs"])
    expect(runs[0].marks).toEqual([{ type: "bold" }])
    expect(runs[1].marks).toEqual([{ type: "italic" }])
    expect(runs[2].marks).toHaveLength(1)
    expect(runs[2].marks[0]).toMatchObject(link)
    expect(runs[3].marks).toBeUndefined()
    expect(stored.blocks[D1].attrs.text).toBe("bilhs")
    expect(fragmentToBlockDoc(seed(stored).fragment, schema)).toEqual(stored)
  })
})

describe("a details' bad child (#213 at depth)", () => {
  it("is dropped on its own, reported with the details and its previous sibling, and restored on the next store", () => {
    const doc = canonical(detailsDoc(), schema)
    doc.blocks[CODE] = { id: CODE, type: "code_block", version: 1, attrs: { code: "" } }
    doc.blocks[D1] = { ...doc.blocks[D1], children: [P1, CODE, IMG, TABLE] }
    const { fragment, dropped } = seed(doc)
    expect(dropped.entries).toEqual([{ id: CODE, parentId: D1, afterId: P1 }])
    const stored = fragmentToBlockDoc(fragment, schema, { dropped })
    expect(stored).toEqual(doc)
  })

  it("a child the table doesn't allow (a details or a group in a details, a list item) is dropped", () => {
    const doc = canonical(detailsDoc(), schema)
    doc.blocks[D1] = { ...doc.blocks[D1], children: [P1, G1] }
    doc.blocks_order = [D1, D2]
    doc.blocks[D2] = { ...doc.blocks[D2], children: [P2] }
    const nested = { ...doc, blocks: { ...doc.blocks, [D1]: { ...doc.blocks[D1], children: [P1, D2] } }, blocks_order: [D1] }
    for (const [d, bad] of [
      [doc, G1],
      [nested, D2],
    ] as const) {
      const { node, dropped } = blockDocToPMWithReport(d, schema)
      expect(() => node.check()).not.toThrow()
      expect(dropped).toContainEqual({ id: bad, parentId: D1, afterId: P1 })
    }
  })

  it("a details left with no child gets one empty paragraph with a deterministic id, after its summary", () => {
    const doc: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [D1],
      blocks: {
        [D1]: { id: D1, type: "details", version: 1, attrs: { summary: [{ type: "text", text: "Q" }], text: "Q" }, children: [CODE] },
        [CODE]: { id: CODE, type: "code_block", version: 1, attrs: { code: "" } },
      },
    }
    const first = blockDocToPMWithReport(doc, schema)
    expect(first.node.toJSON()).toEqual(blockDocToPMWithReport(doc, schema).node.toJSON())
    const details = first.node.firstChild!
    expect(details.childCount).toBe(2)
    expect(details.child(0).textContent).toBe("Q")
    expect(details.child(1).attrs["data-block-id"]).toBe(`${D1}-paragraph`)
    const a = seed(doc)
    const stored = fragmentToBlockDoc(a.fragment, schema, { dropped: a.dropped })
    expect(stored.blocks[D1].children).toEqual([CODE, `${D1}-paragraph`])
    expect(() => validateBlockDoc(stored)).not.toThrow()
  })
})

describe("details ids (#238, design 2.6)", () => {
  it("stampFragmentBlockIds stamps the details and its children, never the summary", () => {
    const { ydoc, fragment } = seed(canonical(detailsDoc(), schema))
    const details = fragment.get(0) as Y.XmlElement
    ydoc.transact(() => {
      details.removeAttribute("data-block-id")
      ;(details.get(1) as Y.XmlElement).setAttribute("data-block-id", "short")
      ;(details.get(2) as Y.XmlElement).setAttribute("data-block-id", P2) // a duplicate of the group's paragraph
    })
    let n = 0
    expect(stampFragmentBlockIds(fragment, () => `fresh-id-${String(++n).padStart(6, "0")}`)).toBe(3)
    expect((details.get(0) as Y.XmlElement).nodeName).toBe("detailsSummary")
    expect((details.get(0) as Y.XmlElement).getAttribute("data-block-id")).toBeUndefined()
    const stored = fragmentToBlockDoc(fragment, schema)
    expect(() => validateBlockDoc(stored)).not.toThrow()
    expect(Object.keys(stored.blocks)).toHaveLength(7)
  })
})

describe("the store falls back per child (design 2.5)", () => {
  function breakChild(ydoc: Y.Doc, container: Y.XmlElement, index: number) {
    const id = (container.get(index) as Y.XmlElement).getAttribute("data-block-id")
    ydoc.transact(() => {
      container.delete(index, 1)
      const malformed = new Y.XmlElement("text")
      container.insert(index, [malformed])
      if (id) malformed.setAttribute("data-block-id", id)
    })
  }

  it("an unconvertible child keeps its previous version under the details; the live summary stays", () => {
    const previous = canonical(detailsDoc(), schema)
    const { ydoc, fragment } = seed(previous)
    const details = fragment.get(0) as Y.XmlElement
    breakChild(ydoc, details, 1) // P1 (index 0 is the summary)
    const unconvertible: UnconvertibleBlock[] = []
    const stored = fragmentToBlockDoc(fragment, schema, { previous, onUnconvertible: (b) => unconvertible.push(b) })
    expect(unconvertible).toEqual([expect.objectContaining({ id: P1, parentId: D1 })])
    expect(stored).toEqual(previous)
  })

  it("a details whose every block is unconvertible falls back as a whole (its summary alone doesn't count)", () => {
    const previous = canonical(detailsDoc(), schema)
    const { ydoc, fragment } = seed(previous)
    const details = fragment.get(0) as Y.XmlElement
    for (let i = 1; i < details.length; i++) breakChild(ydoc, details, i)
    const unconvertible: UnconvertibleBlock[] = []
    const stored = fragmentToBlockDoc(fragment, schema, { previous, onUnconvertible: (b) => unconvertible.push(b) })
    expect(unconvertible.map((b) => b.id)).toEqual([P1, IMG, TABLE, D1])
    expect(stored).toEqual(previous)
  })
})

describe("zDetails (Block Spec)", () => {
  const withDetails = (attrs: Record<string, unknown>, children: string[] = [P1]): BlockDocV1 => ({
    doc_version: 1,
    blocks_order: [D1],
    blocks: {
      [D1]: { id: D1, type: "details", version: 1, attrs, children } as any,
      [P1]: { id: P1, type: "paragraph", version: 1, attrs: {} },
    },
  })

  it("takes the bridge's output and refuses what the bridge never writes", () => {
    expect(() => validateBlockDoc(withDetails({}))).not.toThrow()
    expect(() => validateBlockDoc(withDetails({ open: true, summary: [...SUMMARY], text: "x" }))).not.toThrow()
    expect(() => validateBlockDoc(withDetails({ open: false }))).toThrow()
    expect(() => validateBlockDoc(withDetails({ summary: [{ type: "text", text: "x", marks: [{ type: "code" }] }] }))).toThrow()
    expect(() => validateBlockDoc(withDetails({ summary: [{ type: "text", text: "" }] }))).toThrow()
    // Children: required, at least one, flow only (nestingIssues).
    expect(() => validateBlockDoc(withDetails({}, []))).toThrow()
    const noChildren = withDetails({})
    delete (noChildren.blocks[D1] as any).children
    expect(() => validateBlockDoc(noChildren)).toThrow()
  })
})
