import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as Y from "yjs"
import { validateBlockDoc, type BlockDocV1 } from "../blocks-spec"
import { blockDocToPMWithReport, pmToBlockDoc, restoreDroppedBlocks, stampBlockIds } from "./blockBridge"
import { fragmentToBlockDoc, seedFragment, stampFragmentBlockIds, type UnconvertibleBlock } from "./fragmentBridge"
import { getInstalledCollabSchema } from "../theme-blocks/collabSchema"
import { canonical } from "./fragmentBridge.fixtures"

// Nesting (#414, design 2.5–2.6): containers round-trip through the bridge and the Yjs
// fragment at any depth, a bad child is dropped on its own and comes back on the next
// store, synthesized children have deterministic ids, cycles and double references are
// dropped, and the store falls back per child.

const schema = getInstalledCollabSchema()

const G1 = "blk-group-000001"
const G2 = "blk-group-000002"
const P1 = "blk-para-0000001"
const P2 = "blk-para-0000002"
const P3 = "blk-para-0000003"
const H1 = "blk-head-0000001"
const IMG = "blk-image-000001"
const LIST = "blk-list-0000001"
const I1 = "blk-item-0000001"
const I2 = "blk-item-0000002"
const CODE = "blk-code-0000001"
const ALERT = "blk-alert-000001"
const TOP = "blk-top-00000001"

const paragraph = (id: string, text: string) => ({ id, type: "paragraph", version: 1, attrs: { text } }) as const

/** Two groups holding every kind of flow block, nested to the table's limit (group → list → items). */
function groupDoc(): BlockDocV1 {
  return {
    doc_version: 1,
    blocks_order: [TOP, G1, G2],
    blocks: {
      [TOP]: paragraph(TOP, "Before the groups"),
      [G1]: { id: G1, type: "group", version: 1, attrs: { style: "tinted", align: "wide" }, children: [H1, P1, IMG, LIST] },
      [H1]: { id: H1, type: "heading", version: 1, attrs: { level: 3, text: "Inside a group" } },
      [P1]: {
        id: P1,
        type: "paragraph",
        version: 1,
        attrs: { pm: { type: "paragraph", content: [{ type: "text", text: "Bold", marks: [{ type: "bold" }] }, { type: "text", text: " text" }] } },
      },
      [IMG]: {
        id: IMG,
        type: "image",
        version: 2,
        attrs: { src: "/uploads/a.png", alt: "A", mediaId: 7, align: "full", caption: [{ type: "text", text: "Caption" }] },
      },
      [LIST]: { id: LIST, type: "bullet_list", version: 1, attrs: {}, children: [I1, I2] },
      [I1]: { id: I1, type: "list_item", version: 1, attrs: { text: "one" } },
      [I2]: { id: I2, type: "list_item", version: 1, attrs: { text: "two" } },
      [G2]: { id: G2, type: "group", version: 1, attrs: {}, children: [P2, ALERT, CODE] },
      [P2]: paragraph(P2, "Second group"),
      [ALERT]: { id: ALERT, type: "theme:example/alert", version: 1, attrs: { variant: "warning", text: "Heads up" } },
      [CODE]: { id: CODE, type: "code_block", version: 1, attrs: { language: "js", code: "let a = 1" } },
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

describe("containers round-trip (#414)", () => {
  it("Block Spec → PM → Yjs → Block Spec is unchanged for groups at the table's depth", () => {
    const doc = canonical(groupDoc(), schema)
    // The canonical form keeps every id and the tree.
    expect(doc.blocks_order).toEqual([TOP, G1, G2])
    expect(doc.blocks[G1].children).toEqual([H1, P1, IMG, LIST])
    expect(doc.blocks[LIST].children).toEqual([I1, I2])
    expect(doc.blocks[G2].children).toEqual([P2, ALERT, CODE])
    expect(doc.blocks[G1].attrs).toEqual({ style: "tinted", align: "wide" })
    expect(doc.blocks[G2].attrs).toEqual({})
    expect(() => validateBlockDoc(doc)).not.toThrow()

    const { fragment, dropped } = seed(doc)
    expect(dropped.entries).toEqual([])
    const stored = fragmentToBlockDoc(fragment, schema)
    expect(stored).toEqual(doc)
    // And again from what was stored (no drift on the second load).
    expect(fragmentToBlockDoc(seed(stored).fragment, schema)).toEqual(doc)
  })

  it("defaults are left out of the stored group", () => {
    const { node } = blockDocToPMWithReport(groupDoc(), schema)
    const out = pmToBlockDoc(node)
    expect(out.blocks[G2]).toEqual({ id: G2, type: "group", version: 1, attrs: {}, children: [P2, ALERT, CODE] })
    // An unknown style or width loads as the default and is left out.
    const odd = groupDoc()
    ;(odd.blocks[G1].attrs as any) = { style: "loud", align: "huge" }
    expect(pmToBlockDoc(blockDocToPMWithReport(odd, schema).node).blocks[G1].attrs).toEqual({})
  })
})

describe("a bad child is dropped on its own (#213 at depth)", () => {
  function docWithBadChild(): BlockDocV1 {
    const doc = canonical(groupDoc(), schema)
    // An empty code block can't be a node (ProseMirror has no empty text nodes).
    doc.blocks[CODE] = { id: CODE, type: "code_block", version: 1, attrs: { code: "" } }
    doc.blocks[G2] = { ...doc.blocks[G2], children: [P2, CODE, ALERT] }
    return doc
  }

  it("is reported with its container and previous sibling, and its siblings stay", () => {
    const { node, dropped } = blockDocToPMWithReport(docWithBadChild(), schema)
    expect(() => node.check()).not.toThrow()
    expect(dropped).toEqual([{ id: CODE, parentId: G2, afterId: P2 }])
    const g2 = pmToBlockDoc(node).blocks[G2]
    expect(g2.children).toEqual([P2, ALERT])
  })

  it("is kept in meta.dropped and restored at its place on the next store", () => {
    const doc = docWithBadChild()
    const { fragment, dropped } = seed(doc)
    expect(dropped.entries).toEqual([{ id: CODE, parentId: G2, afterId: P2 }])
    expect(Object.keys(dropped.blocks)).toEqual([CODE])
    const stored = fragmentToBlockDoc(fragment, schema, { dropped })
    expect(stored.blocks[G2].children).toEqual([P2, CODE, ALERT])
    expect(stored.blocks[CODE]).toEqual(doc.blocks[CODE])
    expect(stored).toEqual(doc)
  })

  it("a child the table doesn't allow (a group in a group, a list item) is dropped, not built", () => {
    const doc = canonical(groupDoc(), schema)
    doc.blocks[G1] = { ...doc.blocks[G1], children: [H1, G2, I1] }
    doc.blocks_order = [TOP, G1]
    const { node, dropped } = blockDocToPMWithReport(doc, schema)
    expect(() => node.check()).not.toThrow()
    expect(dropped).toEqual([
      { id: G2, parentId: G1, afterId: H1 },
      { id: I1, parentId: G1, afterId: G2 },
    ])
  })
})

describe("synthesized children", () => {
  function emptyGroupDoc(): BlockDocV1 {
    return {
      doc_version: 1,
      blocks_order: [G1],
      blocks: {
        [G1]: { id: G1, type: "group", version: 1, attrs: {}, children: [CODE] },
        [CODE]: { id: CODE, type: "code_block", version: 1, attrs: { code: "" } },
      },
    }
  }

  it("a group left with no child gets one empty paragraph with a deterministic id", () => {
    const first = blockDocToPMWithReport(emptyGroupDoc(), schema)
    const second = blockDocToPMWithReport(emptyGroupDoc(), schema)
    expect(first.node.toJSON()).toEqual(second.node.toJSON())
    const group = first.node.firstChild!
    expect(group.childCount).toBe(1)
    expect(group.firstChild!.type.name).toBe("paragraph")
    expect(group.firstChild!.attrs["data-block-id"]).toBe(`${G1}-paragraph`)
  })

  it("the same doc stores the same ids on every load (no store churn)", () => {
    const a = seed(emptyGroupDoc())
    const b = seed(emptyGroupDoc())
    const storedA = fragmentToBlockDoc(a.fragment, schema, { dropped: a.dropped })
    const storedB = fragmentToBlockDoc(b.fragment, schema, { dropped: b.dropped })
    expect(storedA).toEqual(storedB)
    expect(storedA.blocks[G1].children).toEqual([CODE, `${G1}-paragraph`])
    expect(() => validateBlockDoc(storedA)).not.toThrow()
    // A second load of what was stored keeps the synthesized paragraph's id.
    const again = seed(storedA)
    expect(fragmentToBlockDoc(again.fragment, schema, { dropped: again.dropped })).toEqual(storedA)
  })
})

describe("cycles and double references", () => {
  it("a block under two groups is built at its first reference only", () => {
    const doc: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [G1, G2],
      blocks: {
        [G1]: { id: G1, type: "group", version: 1, attrs: {}, children: [P1] },
        [G2]: { id: G2, type: "group", version: 1, attrs: {}, children: [P1, P2] },
        [P1]: paragraph(P1, "shared"),
        [P2]: paragraph(P2, "own"),
      },
    }
    const { node, dropped } = blockDocToPMWithReport(doc, schema)
    expect(dropped).toEqual([{ id: P1, parentId: G2, afterId: null }])
    const out = restoreDroppedBlocks(pmToBlockDoc(node), doc, dropped)
    // P1 stays where it was built; the store never writes it under two parents.
    expect(out.blocks[G1].children).toEqual([P1])
    expect(out.blocks[G2].children).toEqual([P2])
    expect(() => validateBlockDoc(out)).not.toThrow()
  })

  it("a block both at the top and in a group is built once", () => {
    const doc: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [G1, P1],
      blocks: {
        [G1]: { id: G1, type: "group", version: 1, attrs: {}, children: [P1, P2] },
        [P1]: paragraph(P1, "shared"),
        [P2]: paragraph(P2, "own"),
      },
    }
    const { node, dropped } = blockDocToPMWithReport(doc, schema)
    expect(node.childCount).toBe(1)
    expect(dropped).toEqual([{ id: P1, parentId: null, afterId: G1 }])
  })

  it("a container that contains itself (through a stored, invalid doc) ends at the child that closes the cycle", () => {
    const doc: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [G1],
      blocks: { [G1]: { id: G1, type: "group", version: 1, attrs: {}, children: [P1, G1] }, [P1]: paragraph(P1, "x") },
    }
    const { node, dropped } = blockDocToPMWithReport(doc, schema)
    expect(() => node.check()).not.toThrow()
    expect(dropped).toEqual([{ id: G1, parentId: G1, afterId: P1 }])
  })

  it("restoring a dropped child doesn't bring back a grandchild that is already elsewhere", () => {
    // P1 moved to the top level since the group was dropped: the restored group mustn't list it.
    const source: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [G1],
      blocks: { [G1]: { id: G1, type: "group", version: 1, attrs: {}, children: [P1, P2] }, [P1]: paragraph(P1, "a"), [P2]: paragraph(P2, "b") },
    }
    const current: BlockDocV1 = { doc_version: 1, blocks_order: [P1], blocks: { [P1]: paragraph(P1, "a") } }
    const out = restoreDroppedBlocks(current, source, [{ id: G1, parentId: null, afterId: P1 }])
    expect(out.blocks_order).toEqual([P1, G1])
    expect(out.blocks[G1].children).toEqual([P2])
    expect(() => validateBlockDoc(out)).not.toThrow()
  })
})

describe("ids at depth (#238, design 2.6)", () => {
  it("pmToBlockDoc regenerates a duplicate id inside a group, across the whole doc", () => {
    const { node } = blockDocToPMWithReport(canonical(groupDoc(), schema), schema)
    // Make the group's first paragraph reuse the top-level paragraph's id (a split copies it).
    const json = node.toJSON()
    json.content[1].content[1].attrs["data-block-id"] = TOP
    const out = pmToBlockDoc(schema.nodeFromJSON(json))
    const children = out.blocks[G1].children!
    expect(children[1]).not.toBe(TOP)
    expect(out.blocks[TOP].attrs).toMatchObject({ text: "Before the groups" })
    expect(() => validateBlockDoc(out)).not.toThrow()
  })

  it("stampFragmentBlockIds stamps a container's children (missing, short or duplicate ids), in one transaction", () => {
    const { ydoc, fragment } = seed(canonical(groupDoc(), schema))
    const g1 = fragment.get(1) as Y.XmlElement
    const [head, para] = g1.toArray() as Y.XmlElement[]
    para.removeAttribute("data-block-id")
    head.setAttribute("data-block-id", P2) // a duplicate of G2's first child, which comes later
    let transactions = 0
    ydoc.on("afterTransaction", () => transactions++)
    let n = 0
    const fresh = () => `blk-fresh-${String(++n).padStart(6, "0")}`
    expect(stampFragmentBlockIds(fragment, fresh)).toBe(2)
    expect(transactions).toBe(1)
    // Document order: the head keeps P2 (it comes first), G2's paragraph gets a new one.
    expect(head.getAttribute("data-block-id")).toBe(P2)
    expect(para.getAttribute("data-block-id")).toMatch(/^blk-fresh-/)
    const g2 = fragment.get(2) as Y.XmlElement
    expect((g2.get(0) as Y.XmlElement).getAttribute("data-block-id")).toMatch(/^blk-fresh-/)
    // Nothing that isn't a block is stamped (the list item's paragraph, the caption).
    const stored = fragmentToBlockDoc(fragment, schema)
    expect(() => validateBlockDoc(stored)).not.toThrow()
    expect(stampFragmentBlockIds(fragment, fresh)).toBe(0)
  })

  it("stampBlockIds uses the same rule", () => {
    const { node } = blockDocToPMWithReport(canonical(groupDoc(), schema), schema)
    const json = node.toJSON()
    delete json.content[1].content[0].attrs["data-block-id"]
    json.content[2].content[0].attrs["data-block-id"] = P1
    const stamped = stampBlockIds(schema.nodeFromJSON(json))
    const out = pmToBlockDoc(stamped)
    expect(new Set(Object.keys(out.blocks)).size).toBe(Object.keys(out.blocks).length)
    expect(stamped.child(1).child(0).attrs["data-block-id"]).toMatch(/.{10,}/)
    expect(stamped.child(2).child(0).attrs["data-block-id"]).not.toBe(P1)
    expect(stampBlockIds(stamped)).toBe(stamped)
  })

  it("pmToBlockDoc skips a childless group (only a schema-invalid node can be one)", () => {
    const node = schema.nodeFromJSON({ type: "doc", content: [{ type: "group", attrs: { "data-block-id": G1 } }, { type: "paragraph" }] })
    const out = pmToBlockDoc(node)
    expect(out.blocks[G1]).toBeUndefined()
    expect(out.blocks_order).toHaveLength(1)
  })
})

/** Replaces a container's child with a malformed element (a peer's bug): a `text` element can't be a node. */
function breakChild(ydoc: Y.Doc, container: Y.XmlElement, index: number) {
  const id = (container.get(index) as Y.XmlElement).getAttribute("data-block-id")
  ydoc.transact(() => {
    container.delete(index, 1)
    const malformed = new Y.XmlElement("text")
    container.insert(index, [malformed])
    if (id) malformed.setAttribute("data-block-id", id)
  })
}

describe("the store falls back per child (design 2.5)", () => {
  it("an unconvertible child keeps its previous version under its container", () => {
    const previous = canonical(groupDoc(), schema)
    const { ydoc, fragment } = seed(previous)
    breakChild(ydoc, fragment.get(1) as Y.XmlElement, 1)
    const unconvertible: UnconvertibleBlock[] = []
    const stored = fragmentToBlockDoc(fragment, schema, { previous, onUnconvertible: (b) => unconvertible.push(b) })
    expect(unconvertible).toHaveLength(1)
    expect(unconvertible[0]).toMatchObject({ id: P1, type: "text", parentId: G1 })
    // P1 comes back from previous at its place; the rest of the group is the live version.
    expect(stored).toEqual(previous)
  })

  it("a container with no child left that converts falls back as a whole", () => {
    const previous = canonical(groupDoc(), schema)
    const { ydoc, fragment } = seed(previous)
    const g2 = fragment.get(2) as Y.XmlElement
    for (let i = 0; i < g2.length; i++) breakChild(ydoc, g2, i)
    const unconvertible: UnconvertibleBlock[] = []
    const stored = fragmentToBlockDoc(fragment, schema, { previous, onUnconvertible: (b) => unconvertible.push(b) })
    expect(unconvertible.map((b) => b.id)).toEqual([P2, ALERT, CODE, G2])
    expect(stored).toEqual(previous)
  })

  it("without a previous version the bad child is left out and the group keeps the rest", () => {
    const doc = canonical(groupDoc(), schema)
    const { ydoc, fragment } = seed(doc)
    breakChild(ydoc, fragment.get(1) as Y.XmlElement, 1)
    const stored = fragmentToBlockDoc(fragment, schema)
    expect(stored.blocks[G1].children).toEqual([H1, IMG, LIST])
    expect(() => validateBlockDoc(stored)).not.toThrow()
  })
})
