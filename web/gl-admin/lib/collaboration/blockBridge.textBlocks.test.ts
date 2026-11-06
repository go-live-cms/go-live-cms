import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as Y from "yjs"
import { validateBlockDoc, type BlockDocV1 } from "../blocks-spec"
import { blockDocToPMWithReport, pmToBlockDoc, synthesizedItemId } from "./blockBridge"
import { fragmentToBlockDoc, seedFragment, stampFragmentBlockIds } from "./fragmentBridge"
import { getInstalledCollabSchema } from "../theme-blocks/collabSchema"
import { canonical } from "./fragmentBridge.fixtures"

// The callout, pull quote and to-do list through the bridge and the Yjs fragment (#419):
// Block Spec → PM → Yjs → Block Spec is unchanged, each block's own attr (tone, cite,
// checked) is canonical on the block and never in its pm, a bad value costs the attr and
// never the block, and to-do items are list items: ids, drops and the synthesized item.

const schema = getInstalledCollabSchema()

const CALLOUT = "blk-callout-00001"
const PULL = "blk-pullquote-001"
const TODO = "blk-todo-list-001"
const T1 = "blk-todo-item-001"
const T2 = "blk-todo-item-002"
const GROUP = "blk-group-0000001"
const INNER = "blk-callout-00002"
const AFTER = "blk-para-00000001"

const text = (value: string, marks?: { type: string }[]) => ({ type: "text", text: value, ...(marks ? { marks } : {}) })

function textBlocksDoc(): BlockDocV1 {
  return {
    doc_version: 1,
    blocks_order: [CALLOUT, PULL, TODO, GROUP, AFTER],
    blocks: {
      [CALLOUT]: {
        id: CALLOUT,
        type: "callout",
        version: 1,
        attrs: {
          tone: "warning",
          pm: {
            type: "callout",
            content: [
              { type: "paragraph", content: [text("Restoring a version "), text("replaces", [{ type: "bold" }]), text(" the working copy.")] },
              { type: "paragraph", content: [text("Second paragraph.")] },
            ],
          },
        },
      },
      [PULL]: {
        id: PULL,
        type: "pull_quote",
        version: 1,
        attrs: { cite: "Ana Costa, editor", pm: { type: "pullQuote", content: [text("Now the editor just "), text("opens", [{ type: "italic" }])] } },
      },
      [TODO]: { id: TODO, type: "todo_list", version: 1, attrs: {}, children: [T1, T2] },
      [T1]: { id: T1, type: "todo_item", version: 1, attrs: { checked: true, text: "Write the post" } },
      [T2]: { id: T2, type: "todo_item", version: 1, attrs: { checked: false, text: "Publish it" } },
      [GROUP]: { id: GROUP, type: "group", version: 1, attrs: {}, children: [INNER] },
      [INNER]: { id: INNER, type: "callout", version: 1, attrs: { tone: "danger", text: "Inside a group" } },
      [AFTER]: { id: AFTER, type: "paragraph", version: 1, attrs: { text: "after" } },
    },
  }
}

function seed(doc: BlockDocV1) {
  const ydoc = new Y.Doc()
  const fragment = ydoc.getXmlFragment("default")
  const dropped = seedFragment(doc, fragment, schema)
  return { ydoc, fragment, dropped }
}

const pmAttrs = (block: { attrs: unknown }) => ((block.attrs as any).pm?.attrs ?? {}) as Record<string, unknown>

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe("full chain round trip (#419)", () => {
  it("Block Spec → PM → Yjs → Block Spec is unchanged, and valid", () => {
    const doc = canonical(textBlocksDoc(), schema)
    expect(doc.blocks_order).toEqual([CALLOUT, PULL, TODO, GROUP, AFTER])
    expect(doc.blocks[TODO].children).toEqual([T1, T2])
    expect(doc.blocks[GROUP].children).toEqual([INNER])
    expect(() => validateBlockDoc(doc)).not.toThrow()

    const { fragment, dropped } = seed(doc)
    expect(dropped.entries).toEqual([])
    const stored = fragmentToBlockDoc(fragment, schema)
    expect(stored).toEqual(doc)
    // Again from what was stored: no drift on the second load.
    expect(fragmentToBlockDoc(seed(stored).fragment, schema)).toEqual(doc)
  })

  it("builds the editor's nodes: callout with paragraphs, pull quote as a textblock, task list items", () => {
    const { node, dropped } = blockDocToPMWithReport(textBlocksDoc(), schema)
    expect(dropped).toEqual([])
    expect(() => node.check()).not.toThrow()
    const [callout, pull, todo] = [node.child(0), node.child(1), node.child(2)]
    expect(callout.type.name).toBe("callout")
    expect(callout.attrs).toMatchObject({ tone: "warning", "data-block-id": CALLOUT })
    expect(callout.childCount).toBe(2)
    expect(pull.type.name).toBe("pullQuote")
    expect(pull.isTextblock).toBe(true)
    expect(pull.attrs).toMatchObject({ cite: "Ana Costa, editor", "data-block-id": PULL })
    expect(todo.type.name).toBe("taskList")
    expect(todo.child(0).type.name).toBe("taskItem")
    expect(todo.child(0).attrs).toMatchObject({ checked: true, "data-block-id": T1 })
    expect(todo.child(1).attrs).toMatchObject({ checked: false, "data-block-id": T2 })
  })

  it("keeps tone, cite and checked on the block, never in its pm", () => {
    const out = pmToBlockDoc(blockDocToPMWithReport(textBlocksDoc(), schema).node)
    expect(out.blocks[CALLOUT].attrs).toMatchObject({ tone: "warning" })
    expect(pmAttrs(out.blocks[CALLOUT])).not.toHaveProperty("tone")
    expect(out.blocks[PULL].attrs).toMatchObject({ cite: "Ana Costa, editor", text: "Now the editor just opens" })
    expect(pmAttrs(out.blocks[PULL])).not.toHaveProperty("cite")
    expect(out.blocks[T1].attrs).toMatchObject({ checked: true, text: "Write the post" })
    expect(out.blocks[T2].attrs).toMatchObject({ checked: false })
    expect(pmAttrs(out.blocks[T1])).not.toHaveProperty("checked")
    expect(out.blocks[TODO]).toEqual({ id: TODO, type: "todo_list", version: 1, attrs: {}, children: [T1, T2] })
    // A callout's paragraphs carry no blockColor null (every stored post would churn, #356).
    expect(JSON.stringify(out.blocks[CALLOUT].attrs)).not.toContain("blockColor")
  })
})

describe("a bad value costs the attr, never the block", () => {
  it("an unknown tone loads as info; a pm's own tone, cite or checked is ignored", () => {
    const doc = textBlocksDoc()
    ;(doc.blocks[CALLOUT].attrs as any).tone = "loud"
    ;(doc.blocks[CALLOUT].attrs as any).pm.attrs = { tone: "danger" }
    ;(doc.blocks[PULL].attrs as any).pm.attrs = { cite: "someone else" }
    ;(doc.blocks[T1].attrs as any) = { checked: true, pm: { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [text("x")] }] } }
    ;(doc.blocks[T2].attrs as any).checked = "yes"
    const { node, dropped } = blockDocToPMWithReport(doc, schema)
    expect(dropped).toEqual([])
    expect(node.child(0).attrs.tone).toBe("info")
    expect(node.child(1).attrs.cite).toBe("Ana Costa, editor")
    expect(node.child(2).child(0).attrs.checked).toBe(true)
    expect(node.child(2).child(1).attrs.checked).toBe(false)
    const out = pmToBlockDoc(node)
    expect((out.blocks[CALLOUT].attrs as any).tone).toBe("info")
    expect(() => validateBlockDoc(out)).not.toThrow()
  })

  it("a citation is stored by the quote's rules: trimmed, capped, absent when blank", () => {
    const doc = textBlocksDoc()
    ;(doc.blocks[PULL].attrs as any).cite = `  ${"é".repeat(320)}  `
    let out = pmToBlockDoc(blockDocToPMWithReport(doc, schema).node)
    expect([...((out.blocks[PULL].attrs as any).cite as string)]).toHaveLength(300)
    ;(doc.blocks[PULL].attrs as any).cite = "   "
    out = pmToBlockDoc(blockDocToPMWithReport(doc, schema).node)
    // Left out of the stored JSON, like a quote's.
    expect(JSON.parse(JSON.stringify(out.blocks[PULL].attrs))).not.toHaveProperty("cite")
  })

  it("a block without pm builds from its text", () => {
    const doc = textBlocksDoc()
    doc.blocks[CALLOUT] = { id: CALLOUT, type: "callout", version: 1, attrs: { text: "Plain" } } as any
    doc.blocks[PULL] = { id: PULL, type: "pull_quote", version: 1, attrs: {} } as any
    const { node, dropped } = blockDocToPMWithReport(doc, schema)
    expect(dropped).toEqual([])
    expect(node.child(0).textContent).toBe("Plain")
    expect(node.child(0).attrs.tone).toBe("info")
    expect(node.child(1).type.name).toBe("pullQuote")
    expect(node.child(1).content.size).toBe(0)
  })
})

describe("to-do items are list items", () => {
  it("a paragraph child becomes an item with its id; any other child is dropped and comes back", () => {
    const doc = canonical(textBlocksDoc(), schema)
    const PARA = "blk-todo-para-001"
    const ITEM = "blk-list-item-001"
    doc.blocks[PARA] = { id: PARA, type: "paragraph", version: 1, attrs: { text: "From a paragraph" } }
    doc.blocks[ITEM] = { id: ITEM, type: "list_item", version: 1, attrs: { text: "A bullet's item" } }
    doc.blocks[TODO] = { ...doc.blocks[TODO], children: [T1, PARA, ITEM, T2] }

    const { node, dropped } = blockDocToPMWithReport(doc, schema)
    expect(() => node.check()).not.toThrow()
    expect(dropped).toEqual([{ id: ITEM, parentId: TODO, afterId: PARA }])
    const todo = node.child(2)
    expect(todo.childCount).toBe(3)
    expect(todo.child(1).type.name).toBe("taskItem")
    expect(todo.child(1).attrs).toMatchObject({ "data-block-id": PARA, checked: false })

    // The store puts the dropped item back where it was.
    const { fragment, dropped: record } = seed(doc)
    const stored = fragmentToBlockDoc(fragment, schema, { dropped: record })
    expect(stored.blocks[TODO].children).toEqual([T1, PARA, ITEM, T2])
    expect(stored.blocks[ITEM]).toEqual(doc.blocks[ITEM])
  })

  it("a to-do list with no item left gets one with a deterministic id", () => {
    const doc = textBlocksDoc()
    doc.blocks[TODO] = { ...doc.blocks[TODO], children: [] }
    const first = blockDocToPMWithReport(doc, schema).node.child(2)
    expect(first.childCount).toBe(1)
    expect(first.child(0).type.name).toBe("taskItem")
    expect(first.child(0).attrs["data-block-id"]).toBe(synthesizedItemId(TODO))
    expect(blockDocToPMWithReport(doc, schema).node.child(2).toJSON()).toEqual(first.toJSON())
  })

  it("the server stamps an item that has no id, once, and never a paragraph inside one", () => {
    const { fragment, ydoc } = seed(canonical(textBlocksDoc(), schema))
    const todo = fragment.toArray().find((n) => n instanceof Y.XmlElement && n.nodeName === "taskList") as Y.XmlElement
    const item = new Y.XmlElement("taskItem")
    const paragraph = new Y.XmlElement("paragraph")
    paragraph.insert(0, [new Y.XmlText("New")])
    item.insert(0, [paragraph])
    ydoc.transact(() => todo.insert(todo.length, [item]))

    expect(stampFragmentBlockIds(fragment)).toBe(1)
    expect(typeof item.getAttribute("data-block-id")).toBe("string")
    expect(paragraph.getAttribute("data-block-id")).toBeUndefined()
    expect(stampFragmentBlockIds(fragment)).toBe(0)
    const stored = fragmentToBlockDoc(fragment, schema)
    expect(stored.blocks[TODO].children).toHaveLength(3)
    expect(() => validateBlockDoc(stored)).not.toThrow()
  })
})
