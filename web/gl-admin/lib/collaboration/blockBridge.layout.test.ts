import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as Y from "yjs"
import { validateBlockDoc, type BlockDocV1 } from "../blocks-spec"
import { blockDocToPMWithReport, pmToBlockDoc, restoreDroppedBlocks } from "./blockBridge"
import { fragmentToBlockDoc, repairColumnsFragment, seedFragment, stampFragmentBlockIds } from "./fragmentBridge"
import { getInstalledCollabSchema } from "../theme-blocks/collabSchema"
import { canonical } from "./fragmentBridge.fixtures"

// Columns, buttons and the spacer through the bridge (#426): round trips at the top and in
// a group, synthesized columns with stable ids, an unsafe href costing only the link,
// defaults left out, and the repair of a count Yjs merged past the table's limits.

const schema = getInstalledCollabSchema()

const G = "blk-group-000001"
const C = "blk-columns-0001"
const C1 = "blk-column-00001"
const C2 = "blk-column-00002"
const P1 = "blk-para-0000001"
const P2 = "blk-para-0000002"
const B = "blk-buttons-0001"
const S = "blk-spacer-00001"

function layoutDoc(): BlockDocV1 {
  return {
    doc_version: 1,
    blocks_order: [G, S],
    blocks: {
      [G]: { id: G, type: "group", version: 1, attrs: { style: "tinted" }, children: [C] },
      [C]: { id: C, type: "columns", version: 1, attrs: { layout: "33-67", align: "wide" }, children: [C1, C2] },
      [C1]: { id: C1, type: "column", version: 1, attrs: {}, children: [P1] },
      [C2]: { id: C2, type: "column", version: 1, attrs: {}, children: [P2, B] },
      [P1]: { id: P1, type: "paragraph", version: 1, attrs: { text: "One" } },
      [P2]: { id: P2, type: "paragraph", version: 1, attrs: { text: "Two" } },
      [B]: {
        id: B,
        type: "buttons",
        version: 1,
        attrs: {
          align: "center",
          text: "Read Log",
          pm: {
            type: "buttons",
            content: [
              { type: "button", attrs: { href: "/guide" }, content: [{ type: "text", text: "Read" }] },
              { type: "button", attrs: { href: "https://example.com", variant: "secondary" }, content: [{ type: "text", text: "Log" }] },
            ],
          },
        },
      },
      [S]: { id: S, type: "spacer", version: 1, attrs: { size: "8" } },
    },
  } as BlockDocV1
}

function seed(doc: BlockDocV1) {
  const ydoc = new Y.Doc()
  const fragment = ydoc.getXmlFragment("default")
  const dropped = seedFragment(doc, fragment, schema)
  return { ydoc, fragment, dropped }
}

const pmParagraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] })

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe("the bridge (#426)", () => {
  it("round-trips nested columns, buttons and a spacer, and the result is valid", () => {
    const { node, dropped } = blockDocToPMWithReport(layoutDoc(), schema)
    expect(dropped).toEqual([])
    expect(() => node.check()).not.toThrow()
    const out = pmToBlockDoc(node)
    expect(canonical(out)).toEqual(canonical(normalizedPm(layoutDoc())))
    expect(() => validateBlockDoc(out)).not.toThrow()
  })

  it("round-trips through the Yjs fragment, at any depth", () => {
    const { fragment, dropped } = seed(layoutDoc())
    expect(dropped.entries).toEqual([])
    const out = fragmentToBlockDoc(fragment, schema)
    expect(() => validateBlockDoc(out)).not.toThrow()
    expect(canonical(out)).toEqual(canonical(normalizedPm(layoutDoc())))
    expect(out.blocks[C].children).toEqual([C1, C2])
    expect(out.blocks[C2].children).toEqual([P2, B])
  })

  it("leaves defaults out, and the layout out unless there are exactly two columns", () => {
    const pm = schema.nodeFromJSON({
      type: "doc",
      content: [
        {
          type: "columns",
          attrs: { "data-block-id": C, layout: "33-67" },
          content: [C1, C2, "blk-column-00003"].map((id) => ({ type: "column", attrs: { "data-block-id": id }, content: [pmParagraph(id)] })),
        },
      ],
    })
    expect(pmToBlockDoc(pm).blocks[C].attrs).toEqual({})
  })

  it("a button is a part: no block, no id", () => {
    const out = pmToBlockDoc(blockDocToPMWithReport(layoutDoc(), schema).node)
    expect(Object.values(out.blocks).map((block) => block.type)).not.toContain("button")
  })

  it("an unsafe href costs the link, never the button or the store", () => {
    const pm = schema.nodeFromJSON({
      type: "doc",
      content: [
        {
          type: "buttons",
          attrs: { "data-block-id": B },
          content: [
            { type: "button", attrs: { href: "javascript:alert(1)", variant: "secondary" }, content: [{ type: "text", text: "Bad" }] },
            { type: "button", attrs: { href: "java\tscript:alert(1)" }, content: [{ type: "text", text: "Worse" }] },
          ],
        },
      ],
    })
    const out = pmToBlockDoc(pm)
    expect(() => validateBlockDoc(out)).not.toThrow()
    expect((out.blocks[B].attrs as any).pm.content).toEqual([
      { type: "button", attrs: { variant: "secondary" }, content: [{ type: "text", text: "Bad" }] },
      { type: "button", content: [{ type: "text", text: "Worse" }] },
    ])
    expect(JSON.stringify(out)).not.toContain("javascript")
  })

  it("a stored unsafe href never reaches the editor, nor an unknown style or marks", () => {
    const doc = layoutDoc()
    ;(doc.blocks[B].attrs as any).pm.content = [{ type: "button", attrs: { href: "javascript:alert(1)", variant: "huge" }, content: [{ type: "text", text: "X", marks: [{ type: "bold" }] }] }]
    const { node, dropped } = blockDocToPMWithReport(doc, schema)
    expect(dropped).toEqual([])
    const json = JSON.stringify(node.toJSON())
    expect(json).not.toContain("javascript")
    expect(json).not.toContain("bold")
    expect(json).toContain('"variant":"primary"')
  })

  it("a buttons block with no buttons left gets one empty one", () => {
    const doc = layoutDoc()
    ;(doc.blocks[B].attrs as any).pm.content = [{ type: "paragraph" }]
    const { node, dropped } = blockDocToPMWithReport(doc, schema)
    expect(dropped).toEqual([])
    expect(() => node.check()).not.toThrow()
  })

  it("an unknown spacer size reads as the default, a stored one survives", () => {
    const doc = layoutDoc()
    ;(doc.blocks[S].attrs as any).size = "13"
    const node = blockDocToPMWithReport(doc, schema).node
    expect(node.lastChild!.attrs.size).toBe("7")
    expect(pmToBlockDoc(node).blocks[S].attrs).toEqual({ size: "7" })
  })

  it("a columns block left with too few children gets synthesized columns with stable ids", () => {
    const doc = layoutDoc()
    doc.blocks[C].children = [C1, "not-a-block-000"]
    const load = () => blockDocToPMWithReport(doc, schema).node
    const first = pmToBlockDoc(load())
    const second = pmToBlockDoc(load())
    expect(first.blocks[C].children).toHaveLength(2)
    expect(first.blocks[C].children).toEqual([C1, `${C}-column-part-2`])
    expect(canonical(first)).toEqual(canonical(second))
    expect(() => validateBlockDoc(first)).not.toThrow()
  })

  it("a column that can't be built is dropped on its own and restored by the store", () => {
    const doc = layoutDoc()
    // A group is not allowed in a column: it costs the group, not the column.
    doc.blocks[C1].children = ["blk-group-000002", P1]
    doc.blocks["blk-group-000002"] = { id: "blk-group-000002", type: "group", version: 1, attrs: {}, children: ["blk-para-0000003"] }
    doc.blocks["blk-para-0000003"] = { id: "blk-para-0000003", type: "paragraph", version: 1, attrs: { text: "nested" } }
    const { node, dropped } = blockDocToPMWithReport(doc, schema)
    expect(dropped).toEqual([{ id: "blk-group-000002", parentId: C1, afterId: null }])
    expect(() => node.check()).not.toThrow()
    const out = restoreDroppedBlocks(pmToBlockDoc(node), doc, dropped)
    expect(out.blocks[C1].children).toEqual(["blk-group-000002", P1])
  })

  it("stamps every column and its blocks, never a button", () => {
    const { fragment } = seed(layoutDoc())
    expect(stampFragmentBlockIds(fragment)).toBe(0)
  })
})

// `pm` as the bridge writes it (a button's variant only when not the default).
function normalizedPm(doc: BlockDocV1): BlockDocV1 {
  return doc
}

describe("repairColumnsFragment (#426)", () => {
  function columnsFragment(columnTexts: string[][]) {
    const ydoc = new Y.Doc()
    const fragment = ydoc.getXmlFragment("default")
    const element = new Y.XmlElement("columns")
    element.setAttribute("data-block-id", C)
    element.setAttribute("layout", "equal")
    ydoc.transact(() => {
      fragment.insert(0, [element])
      columnTexts.forEach((texts, index) => {
        const column = new Y.XmlElement("column")
        column.setAttribute("data-block-id", `blk-column-0000${index}`)
        element.insert(index, [column])
        texts.forEach((text, at) => {
          const paragraph = new Y.XmlElement("paragraph")
          paragraph.setAttribute("data-block-id", `blk-para-${index}-00000${at}`)
          column.insert(at, [paragraph])
          const run = new Y.XmlText()
          paragraph.insert(0, [run])
          run.insert(0, text)
        })
      })
    })
    return { ydoc, fragment, element }
  }
  const texts = (element: Y.XmlElement) =>
    element.toArray().map((column) => (column as Y.XmlElement).toArray().map((paragraph) => (paragraph as Y.XmlElement).toString().replace(/<[^>]+>/g, "")))

  it("leaves a valid doc alone: no update", () => {
    const { ydoc, fragment } = columnsFragment([["a"], ["b"]])
    const updates: Uint8Array[] = []
    ydoc.on("update", (update) => updates.push(update))
    expect(repairColumnsFragment(fragment)).toBe(0)
    expect(updates).toEqual([])
  })

  it("five columns: the fifth gives its blocks to the fourth, nothing is lost", () => {
    const { fragment, element } = columnsFragment([["a"], ["b"], ["c"], ["d"], ["e", "f"]])
    expect(repairColumnsFragment(fragment)).toBe(1)
    expect(texts(element)).toEqual([["a"], ["b"], ["c"], ["d", "e", "f"]])
    // The moved paragraphs keep their ids.
    const last = element.toArray()[3] as Y.XmlElement
    expect((last.toArray()[1] as Y.XmlElement).getAttribute("data-block-id")).toBe("blk-para-4-000000")
    const out = fragmentToBlockDoc(fragment, schema)
    expect(() => validateBlockDoc(out)).not.toThrow()
    expect(repairColumnsFragment(fragment)).toBe(0)
  })

  it("one column: an empty one is added, ids stamped, and the store is valid", () => {
    const { fragment, element } = columnsFragment([["a"]])
    expect(repairColumnsFragment(fragment)).toBe(1)
    expect(element.length).toBe(2)
    stampFragmentBlockIds(fragment)
    expect(() => validateBlockDoc(fragmentToBlockDoc(fragment, schema))).not.toThrow()
  })

  it("an empty column gets an empty paragraph", () => {
    const { fragment, element } = columnsFragment([[], ["b"]])
    expect(repairColumnsFragment(fragment)).toBe(1)
    expect((element.toArray()[0] as Y.XmlElement).length).toBe(1)
    stampFragmentBlockIds(fragment)
    expect(() => validateBlockDoc(fragmentToBlockDoc(fragment, schema))).not.toThrow()
  })

  it("finds columns inside a group", () => {
    const ydoc = new Y.Doc()
    const fragment = ydoc.getXmlFragment("default")
    const group = new Y.XmlElement("group")
    const columns = new Y.XmlElement("columns")
    ydoc.transact(() => {
      fragment.insert(0, [group])
      group.insert(0, [columns])
      const column = new Y.XmlElement("column")
      columns.insert(0, [column])
      column.insert(0, [new Y.XmlElement("paragraph")])
    })
    expect(repairColumnsFragment(fragment)).toBe(1)
    expect(columns.length).toBe(2)
  })
})
