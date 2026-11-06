import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as Y from "yjs"
import { clampTableSpan, tableRows, TABLE_MAX_SPAN, validateBlockDoc, type BlockDocV1 } from "../blocks-spec"
import { blockDocToPMWithReport, pmToBlockDoc, restoreDroppedBlocks } from "./blockBridge"
import { fragmentToBlockDoc, seedFragment } from "./fragmentBridge"
import { getInstalledCollabSchema } from "../theme-blocks/collabSchema"

// The table (#420) through the whole chain the editor and the collab server use: Block
// Spec → ProseMirror → Block Spec, and through the Yjs fragment (seed, store). Rows live in
// the block's `pm`, `headerRow` is canonical (stored cells are all `tableCell`), the
// caption is runs, spans are clamped, and a table the editor can't build is hidden and
// kept (#213), never lost.

const schema = getInstalledCollabSchema()

const TABLE = "blk-0420-table-000001"
const GROUP = "blk-0420-group-000001"
const AFTER = "blk-0420-after-000001"

const p = (...runs: any[]) => ({ type: "paragraph", ...(runs.length > 0 ? { content: runs } : {}) })
const t = (text: string, ...marks: string[]) => ({ type: "text", text, ...(marks.length > 0 ? { marks: marks.map((type) => ({ type })) } : {}) })
const cell = (content: any[], attrs?: Record<string, number>) => ({ type: "tableCell", ...(attrs ? { attrs } : {}), content })
const row = (...cells: any[]) => ({ type: "tableRow", content: cells })

/** A table as Block Spec stores it: a header row, a cell spanning two columns, two paragraphs in one cell, marks. */
function tableDoc(): BlockDocV1 {
  return {
    doc_version: 1,
    blocks_order: [TABLE, AFTER],
    blocks: {
      [TABLE]: {
        id: TABLE,
        type: "table",
        version: 1,
        attrs: {
          pm: {
            type: "table",
            content: [
              row(cell([p(t("Role"))]), cell([p(t("Write"))]), cell([p(t("Publish"))])),
              row(cell([p(t("Admin", "bold"))]), cell([p(t("Everything"))], { colspan: 2 })),
              row(cell([p(t("Contributor"))]), cell([p(t("Their own")), p(t("drafts"))]), cell([p()])),
            ],
          },
          text: "Role Write Publish\nAdmin Everything\nContributor Their own drafts",
          headerRow: true,
          caption: [t("Who can "), t("do", "italic"), t(" what")],
        },
      },
      [AFTER]: { id: AFTER, type: "paragraph", version: 1, attrs: { text: "after" } },
    },
  }
}

/** One load and save through the bridge: what the editor and the collab store make of `doc`. */
const stored = (doc: BlockDocV1) => pmToBlockDoc(blockDocToPMWithReport(doc, schema).node)

function seed(doc: BlockDocV1) {
  const ydoc = new Y.Doc()
  const fragment = ydoc.getXmlFragment("default")
  const dropped = seedFragment(doc, fragment, schema)
  return { fragment, dropped }
}

describe("table through the bridge (#420)", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it("builds the table block: grid, header cells only in a header row, spans, the caption", () => {
    const { node, dropped } = blockDocToPMWithReport(tableDoc(), schema)
    expect(dropped).toEqual([])
    node.check()
    const block = node.child(0)
    expect(block.type.name).toBe("tableBlock")
    expect(block.attrs["data-block-id"]).toBe(TABLE)
    expect(block.childCount).toBe(2)
    const [grid, caption] = [block.child(0), block.child(1)]
    expect(grid.type.name).toBe("table")
    expect(caption.type.name).toBe("tableCaption")
    expect(caption.textContent).toBe("Who can do what")
    expect(caption.child(1).marks.map((m) => m.type.name)).toEqual(["italic"])
    const types = Array.from({ length: grid.childCount }, (_, r) => Array.from({ length: grid.child(r).childCount }, (_, c) => grid.child(r).child(c).type.name))
    expect(types).toEqual([
      ["tableHeader", "tableHeader", "tableHeader"],
      ["tableCell", "tableCell"],
      ["tableCell", "tableCell", "tableCell"],
    ])
    expect(grid.child(1).child(1).attrs).toEqual({ colspan: 2, rowspan: 1 })
    expect(grid.child(2).child(1).childCount).toBe(2)
    // Grid parts carry no block id: only the table block is a block.
    expect("data-block-id" in grid.attrs).toBe(false)
  })

  it("round-trips Block Spec → PM → Block Spec unchanged, and the result is valid", () => {
    const once = stored(tableDoc())
    expect(() => validateBlockDoc(once)).not.toThrow()
    const block = once.blocks[TABLE]
    expect(block).toMatchObject({ id: TABLE, type: "table", version: 1 })
    expect(block.children).toBeUndefined()
    const attrs = block.attrs as any
    expect(attrs.headerRow).toBe(true)
    expect(attrs.caption).toEqual([t("Who can "), t("do", "italic"), t(" what")])
    expect(attrs.text).toBe("Role Write Publish\nAdmin Everything\nContributor Their own drafts")
    // Every stored cell is a tableCell: the header row is `headerRow`, canonical.
    const cells = attrs.pm.content.flatMap((r: any) => r.content)
    expect(new Set(cells.map((c: any) => c.type))).toEqual(new Set(["tableCell"]))
    expect(attrs.pm.content[1].content[1].attrs).toEqual({ colspan: 2 })
    expect(attrs.pm.content[0].content[0].attrs).toBeUndefined()
    expect(tableRows(attrs.pm).map((r) => r.length)).toEqual([3, 2, 3])
    // Stable: a second load and save is the same doc (the store sees no change).
    expect(stored(once)).toEqual(once)
  })

  it("round-trips through the Yjs fragment the collab server seeds and stores", () => {
    const doc = stored(tableDoc())
    const { fragment, dropped } = seed(doc)
    expect(dropped.entries).toEqual([])
    const back = fragmentToBlockDoc(fragment, schema)
    expect(back).toEqual(doc)
    expect(fragmentToBlockDoc(seed(back).fragment, schema)).toEqual(doc)
  })

  it("leaves the defaults out: no header row, no caption", () => {
    const doc = tableDoc()
    const attrs = doc.blocks[TABLE].attrs as any
    delete attrs.headerRow
    delete attrs.caption
    const once = stored(doc)
    const out = once.blocks[TABLE].attrs as any
    expect("headerRow" in out).toBe(false)
    expect("caption" in out).toBe(false)
    const grid = blockDocToPMWithReport(once, schema).node.child(0).child(0)
    expect(grid.child(0).child(0).type.name).toBe("tableCell")
    // An empty caption node is still there to type in.
    expect(blockDocToPMWithReport(once, schema).node.child(0).child(1).type.name).toBe("tableCaption")
  })

  it("normalizes what a bad or older write left: header cells in the body, spans, non-paragraphs, unknown attrs", () => {
    const doc = tableDoc()
    const attrs = doc.blocks[TABLE].attrs as any
    attrs.headerRow = undefined
    attrs.pm.content[2].content[0] = { type: "tableHeader", attrs: { colspan: 999, colwidth: [120] }, content: [p(t("Contributor"))] }
    attrs.pm.content[1].content[1].attrs = { colspan: "abc", rowspan: 0 }
    attrs.pm.content[2].content[1].content = [{ type: "heading", attrs: { level: 2 }, content: [t("lost")] }, p(t("kept"))]
    attrs.pm.content.push({ type: "paragraph", content: [t("not a row")] })
    const { node, dropped } = blockDocToPMWithReport(doc, schema)
    expect(dropped).toEqual([])
    node.check()
    const grid = node.child(0).child(0)
    expect(grid.childCount).toBe(3)
    expect(grid.child(2).child(0).type.name).toBe("tableCell")
    expect(grid.child(2).child(0).attrs).toEqual({ colspan: TABLE_MAX_SPAN, rowspan: 1 })
    expect(grid.child(1).child(1).attrs).toEqual({ colspan: 1, rowspan: 1 })
    expect(grid.child(2).child(1).textContent).toBe("kept")
    const out = pmToBlockDoc(node)
    expect(() => validateBlockDoc(out)).not.toThrow()
    expect((out.blocks[TABLE].attrs as any).pm.content[2].content[0].attrs).toEqual({ colspan: TABLE_MAX_SPAN })
  })

  it("hides a table it can't build (no rows) and puts it back on the next store (#213)", () => {
    const doc = tableDoc()
    ;(doc.blocks[TABLE].attrs as any).pm = { type: "table", content: [] }
    const { node, dropped } = blockDocToPMWithReport(doc, schema)
    expect(dropped).toEqual([{ id: TABLE, parentId: null, afterId: null }])
    expect(node.childCount).toBe(1)
    const restored = restoreDroppedBlocks(pmToBlockDoc(node), doc, dropped)
    expect(restored.blocks_order).toEqual([TABLE, AFTER])
    expect(restored.blocks[TABLE]).toEqual(doc.blocks[TABLE])
  })

  it("is a flow block of a group: it round-trips as the group's child, with its own id", () => {
    const doc = tableDoc()
    doc.blocks_order = [GROUP, AFTER]
    doc.blocks[GROUP] = { id: GROUP, type: "group", version: 1, attrs: {}, children: [TABLE] }
    const once = stored(doc)
    expect(() => validateBlockDoc(once)).not.toThrow()
    expect(once.blocks[GROUP].children).toEqual([TABLE])
    expect(once.blocks[TABLE].type).toBe("table")
    expect(fragmentToBlockDoc(seed(once).fragment, schema)).toEqual(once)
  })
})

describe("Block Spec validation of a table (#420)", () => {
  const valid = () => stored(tableDoc())
  const withAttrs = (change: (attrs: any, block: any) => void) => {
    const doc = valid()
    change(doc.blocks[TABLE].attrs, doc.blocks[TABLE])
    return doc
  }

  it("accepts what the bridge writes", () => {
    expect(() => validateBlockDoc(valid())).not.toThrow()
  })

  it.each([
    ["children (a table holds no blocks)", (_a: any, b: any) => (b.children = [AFTER])],
    ["headerRow: false (absent is the default)", (a: any) => (a.headerRow = false)],
    ["a pm that isn't a table", (a: any) => (a.pm = { type: "paragraph" })],
    ["no rows", (a: any) => (a.pm.content = [])],
    ["a row with no cells", (a: any) => (a.pm.content[0].content = [])],
    ["a heading in a cell", (a: any) => (a.pm.content[0].content[0].content = [{ type: "heading", attrs: { level: 2 } }])],
    ["a cell with no paragraph", (a: any) => (a.pm.content[0].content[0].content = [])],
    ["a span of 1 stored", (a: any) => (a.pm.content[0].content[0].attrs = { colspan: 1 })],
    [`a span over ${TABLE_MAX_SPAN}`, (a: any) => (a.pm.content[0].content[0].attrs = { rowspan: TABLE_MAX_SPAN + 1 })],
    ["another cell attr", (a: any) => (a.pm.content[0].content[0].attrs = { colwidth: [100] })],
    ["a caption run with a mark captions don't take", (a: any) => (a.caption = [{ type: "text", text: "x", marks: [{ type: "code" }] }])],
  ])("refuses %s", (_name, change) => {
    expect(() => validateBlockDoc(withAttrs(change as any))).toThrow()
  })

  it("clamps spans the way the API does", () => {
    expect([clampTableSpan(2), clampTableSpan(0), clampTableSpan(-3), clampTableSpan(2.7), clampTableSpan("3"), clampTableSpan("x"), clampTableSpan(1e9), clampTableSpan(null)]).toEqual([
      2, 1, 1, 2, 3, 1, TABLE_MAX_SPAN, 1,
    ])
  })
})
