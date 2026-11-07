import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import * as Y from "yjs"
import { Editor } from "@tiptap/core"
import Collaboration from "@tiptap/extension-collaboration"
import type { Node as PMNode } from "@tiptap/pm/model"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { canonical } from "@gl-admin/lib/collaboration/fragmentBridge.fixtures"
import { startRelay, waitFor, type Relay } from "@gl-admin/lib/collaboration/hocuspocusRelay.testkit"
import { isBlockNode, validateBlockDoc, type BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { BlockNodeViews } from "./BlockNodeViews"
import { PasteSanitizer } from "./PasteSanitizer"

// The callout, pull quote and to-do list with two users on the real collab server
// (#419): a tone change, a citation, ticked and new to-do items and typing all merge,
// every block (to-do items included) keeps a unique id on both peers, the stored
// block_doc is valid with each value where Block Spec keeps it, and a later user loads
// the same doc.

const editors: Editor[] = []
let relay: Relay

function makeEditor(doc: Y.Doc): Editor {
  const element = document.createElement("div")
  document.body.appendChild(element)
  const editor = new Editor({
    element,
    extensions: [
      ...Object.values(schemaExtensions({ collaborating: true })),
      BlockNodeViews,
      PasteSanitizer,
      Collaboration.configure({ document: doc }),
    ],
  })
  editors.push(editor)
  return editor
}

const CALLOUT = "blk-0419-callout-0001"
const PULL = "blk-0419-pullqte-0001"
const TODO = "blk-0419-todolst-0001"
const T1 = "blk-0419-todoitm-0001"
const T2 = "blk-0419-todoitm-0002"
const AFTER = "blk-0419-after-000001"

const seed: BlockDocV1 = {
  doc_version: 1,
  blocks_order: [CALLOUT, PULL, TODO, AFTER],
  blocks: {
    [CALLOUT]: { id: CALLOUT, type: "callout", version: 1, attrs: { tone: "info", text: "Note" } },
    [PULL]: { id: PULL, type: "pull_quote", version: 1, attrs: { text: "Set large" } },
    [TODO]: { id: TODO, type: "todo_list", version: 1, attrs: {}, children: [T1, T2] },
    [T1]: { id: T1, type: "todo_item", version: 1, attrs: { checked: false, text: "one" } },
    [T2]: { id: T2, type: "todo_item", version: 1, attrs: { checked: false, text: "two" } },
    [AFTER]: { id: AFTER, type: "paragraph", version: 1, attrs: { text: "after" } },
  },
}

function blockIds(doc: PMNode): unknown[] {
  const ids: unknown[] = []
  const walk = (node: PMNode, parentName: string | null) =>
    node.forEach((child) => {
      if (isBlockNode(child.type.name, parentName)) ids.push(child.attrs["data-block-id"])
      if (!child.isTextblock) walk(child, child.type.name)
    })
  walk(doc, null)
  return ids
}

const unique = (ids: unknown[]) => ids.every((id) => typeof id === "string" && id.length >= 10) && new Set(ids).size === ids.length

/** The node with this id, and its position. */
function find(editor: Editor, id: string): { node: PMNode; pos: number } {
  let found: { node: PMNode; pos: number } | null = null
  editor.state.doc.descendants((node, pos) => {
    if (!found && node.attrs["data-block-id"] === id) found = { node, pos }
  })
  if (!found) throw new Error(`no ${id}`)
  return found
}

/** The end of the text of the block with this id (a textblock, or the last paragraph inside one). */
const endOf = (editor: Editor, id: string) => {
  const { node, pos } = find(editor, id)
  return node.isTextblock ? pos + node.nodeSize - 1 : pos + node.nodeSize - 2
}

const same = (a: Editor, b: Editor) => JSON.stringify(a.state.doc.toJSON()) === JSON.stringify(b.state.doc.toJSON())

describe("callout, pull quote and to-do list with two users on the relay (#419)", () => {
  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    relay = await startRelay({ blockDoc: canonical(seed), revision: 2 })
  })
  afterEach(async () => {
    while (editors.length) {
      const editor = editors.pop()!
      const element = editor.options.element as HTMLElement
      editor.destroy()
      element.remove()
    }
    await relay.destroy()
    vi.restoreAllMocks()
  })

  it("their edits merge, ids stay unique, and the stored block_doc keeps tone, cite and checked", async () => {
    const pa = relay.client("1")
    const pb = relay.client("2")
    await Promise.all([pa.whenSynced(), pb.whenSynced()])
    const a = makeEditor(pa.doc)
    const b = makeEditor(pb.doc)
    await waitFor(() => b.getText().includes("two"), { what: "b to load" })
    expect(a.state.doc.child(0).type.name).toBe("callout")
    expect(a.state.doc.child(2).type.name).toBe("taskList")

    // At the same time: A sets the callout's tone and types in it, and gives the pull
    // quote a citation; B ticks the first to-do, adds a third, and types in the pull quote.
    a.commands.setTextSelection(endOf(a, CALLOUT))
    a.commands.setCalloutTone("danger")
    a.commands.insertContent(" from A")
    const pull = find(a, PULL)
    a.view.dispatch(a.state.tr.setNodeMarkup(pull.pos, undefined, { ...pull.node.attrs, cite: "Ana Costa" }))

    const t1 = find(b, T1)
    b.view.dispatch(b.state.tr.setNodeMarkup(t1.pos, undefined, { ...t1.node.attrs, checked: true }))
    b.commands.setTextSelection(endOf(b, T2))
    b.commands.splitListItem("taskItem")
    b.commands.insertContent("three from B")
    b.commands.setTextSelection(endOf(b, PULL))
    b.commands.insertContent(" from B")

    await waitFor(() => same(a, b) && a.getText().includes("three from B") && b.getText().includes("Note from A"), { what: "convergence" })
    expect(a.state.doc.child(0).attrs.tone).toBe("danger")
    expect(a.state.doc.child(1).attrs.cite).toBe("Ana Costa")
    const list = a.state.doc.child(2)
    expect(list.childCount).toBe(3)
    expect(list.child(0).attrs).toMatchObject({ "data-block-id": T1, checked: true })
    expect(list.child(2).attrs.checked).toBe(false)
    expect(unique(blockIds(a.state.doc))).toBe(true)
    expect(blockIds(a.state.doc)).toEqual(blockIds(b.state.doc))

    const stored = () => relay.api.posts.get("12")!.block_doc!
    await waitFor(
      () =>
        (stored().blocks[TODO]?.children?.length ?? 0) === 3 &&
        (stored().blocks[CALLOUT]?.attrs as any)?.tone === "danger" &&
        (stored().blocks[PULL]?.attrs as any)?.cite === "Ana Costa" &&
        String((stored().blocks[PULL]?.attrs as any)?.text).includes("from B"),
      { what: "the store" },
    )
    const doc = stored()
    expect(() => validateBlockDoc(doc)).not.toThrow()
    expect(doc.blocks_order).toEqual([CALLOUT, PULL, TODO, AFTER])
    expect(doc.blocks[CALLOUT].attrs).toMatchObject({ tone: "danger", text: "Note from A" })
    expect((doc.blocks[CALLOUT].attrs as any).pm.attrs).not.toHaveProperty("tone")
    expect(doc.blocks[PULL].attrs).toMatchObject({ cite: "Ana Costa", text: "Set large from B" })
    const children = doc.blocks[TODO].children!
    expect(children.slice(0, 2)).toEqual([T1, T2])
    expect(doc.blocks[T1].attrs).toMatchObject({ checked: true, text: "one" })
    expect(doc.blocks[children[2]]).toMatchObject({ type: "todo_item", attrs: { checked: false, text: "three from B" } })
    expect((doc.blocks[T1].attrs as any).pm.attrs).not.toHaveProperty("checked")

    // A third user opening the post later gets the same doc from the server.
    const pc = relay.client("3")
    await pc.whenSynced()
    const c = makeEditor(pc.doc)
    await waitFor(() => c.getText().includes("three from B"), { what: "c to load" })
    expect(c.state.doc.toJSON()).toEqual(a.state.doc.toJSON())
  })

  it("survives a collab server restart: the reseeded doc has the same blocks and values", async () => {
    const pa = relay.client("1")
    await pa.whenSynced()
    const a = makeEditor(pa.doc)
    await waitFor(() => a.getText().includes("two"), { what: "a to load" })
    a.commands.setTextSelection(endOf(a, CALLOUT))
    a.commands.setCalloutTone("success")
    const t2 = find(a, T2)
    a.view.dispatch(a.state.tr.setNodeMarkup(t2.pos, undefined, { ...t2.node.attrs, checked: true }))
    const stored = () => relay.api.posts.get("12")!.block_doc!
    await waitFor(() => (stored().blocks[CALLOUT]?.attrs as any)?.tone === "success" && (stored().blocks[T2]?.attrs as any)?.checked === true, {
      what: "the store",
    })

    await relay.restart()
    const pb = relay.client("2")
    await pb.whenSynced()
    const b = makeEditor(pb.doc)
    await waitFor(() => b.getText().includes("two"), { what: "b to load after the restart" })
    expect(b.state.doc.child(0).attrs.tone).toBe("success")
    expect(b.state.doc.child(2).child(1).attrs).toMatchObject({ "data-block-id": T2, checked: true })
    expect(unique(blockIds(b.state.doc))).toBe(true)
  })
})
