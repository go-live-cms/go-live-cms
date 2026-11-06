import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import type * as Y from "yjs"
import { Editor } from "@tiptap/core"
import Collaboration, { isChangeOrigin } from "@tiptap/extension-collaboration"
import type { Node as PMNode } from "@tiptap/pm/model"
import { isBlockNode, validateBlockDoc, type BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { canonical } from "@gl-admin/lib/collaboration/fragmentBridge.fixtures"
import { startRelay, waitFor, POST_ID, type Relay } from "@gl-admin/lib/collaboration/hocuspocusRelay.testkit"
import { BlockNavigationKeys, BlockSelectionKeys } from "../extensions/BlockNavigation"
import { dropTargetFor, editorBlockById, planBlockMove } from "./blockTree"
import { applyBlockMove } from "./blockMoveSync"
import { NodeSelectionGuard } from "../extensions/NodeSelectionGuard"
import { NodeSelection } from "@tiptap/pm/state"

// Moving blocks between slots with two people on the post (#417), on the real collab
// server (hocuspocusRelay.testkit.ts): a drag into or out of a group is one Yjs
// transaction and one undo step, the block keeps its id in both editors and the stored
// block_doc, and nothing re-stamps afterwards (rule 7). Yjs has no move (design 2.12):
// two people moving the same block at once end with two copies, which the server's
// stamping gives distinct ids, and nothing is lost.

const editors: Editor[] = []
let relay: Relay

const GROUP = "blk-0417-group-000001"
const A = "blk-0417-para-a00001"
const B = "blk-0417-para-b00001"
const C = "blk-0417-para-c00001"
const END = "blk-0417-end-000001"

const seed: BlockDocV1 = {
  doc_version: 1,
  blocks_order: [GROUP, C, END],
  blocks: {
    [GROUP]: { id: GROUP, type: "group", version: 1, attrs: {}, children: [A, B] },
    [A]: { id: A, type: "paragraph", version: 1, attrs: { text: "alpha" } },
    [B]: { id: B, type: "paragraph", version: 1, attrs: { text: "beta" } },
    [C]: { id: C, type: "paragraph", version: 1, attrs: { text: "gamma" } },
    [END]: { id: END, type: "paragraph", version: 1, attrs: { text: "end" } },
  },
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  relay = await startRelay({ blockDoc: canonical(seed), revision: 2 })
})

afterEach(async () => {
  while (editors.length) editors.pop()!.destroy()
  await relay.destroy()
  vi.restoreAllMocks()
})

function makePeer(doc: Y.Doc): Editor {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      ...Object.values(schemaExtensions({ collaborating: true })),
      BlockSelectionKeys,
      BlockNavigationKeys,
      Collaboration.configure({ document: doc }),
      NodeSelectionGuard,
    ],
  })
  editors.push(editor)
  return editor
}

async function twoEditors() {
  const pa = relay.client("1")
  const pb = relay.client("2")
  await Promise.all([pa.whenSynced(), pb.whenSynced()])
  const a = makePeer(pa.doc)
  const b = makePeer(pb.doc)
  await waitFor(() => a.getText().includes("end") && b.getText().includes("end"), { what: "both to load" })
  return { pa, pb, a, b }
}

const json = (editor: Editor) => JSON.stringify(editor.state.doc.toJSON())
const converged = (a: Editor, b: Editor, what: string) => waitFor(() => json(a) === json(b), { what })

/** "group[alpha,beta],gamma,end": the doc's blocks by text, containers with their blocks. */
function shape(doc: PMNode): string {
  const walk = (node: PMNode): string => {
    const out: string[] = []
    node.forEach((child) => {
      if (child.type.name === "paragraph" && child.textContent === "") return // TipTap's trailing line
      out.push(child.type.name === "group" ? `group[${walk(child)}]` : child.textContent)
    })
    return out.join(",")
  }
  return walk(doc)
}

function blockIds(doc: PMNode): string[] {
  const ids: string[] = []
  const walk = (node: PMNode, parentName: string | null) =>
    node.forEach((child) => {
      if (isBlockNode(child.type.name, parentName)) ids.push(child.attrs["data-block-id"])
      if (!child.isTextblock) walk(child, child.type.name)
    })
  walk(doc, null)
  return ids
}

const unique = (ids: string[]) => ids.every((id) => typeof id === "string" && id.length >= 10) && new Set(ids).size === ids.length

/** The drag of `id` onto `side` of `overId`, as the gutter's drop runs it. */
function drag(editor: Editor, id: string, overId: string, side: "before" | "after") {
  const { state } = editor
  const dragged = editorBlockById(state.doc, id)!
  const target = dropTargetFor(state.doc, dragged, editorBlockById(state.doc, overId)!, side)!
  const move = planBlockMove(state, dragged, target)!
  applyBlockMove(editor.view, { ...move, tr: move.tr.setMeta("uiEvent", "drop") })
}

function localTransactions(doc: Y.Doc, run: () => void): number {
  let count = 0
  const onTransaction = (tr: Y.Transaction) => {
    if (tr.local && tr.changed.size > 0) count++
  }
  doc.on("afterTransaction", onTransaction)
  run()
  doc.off("afterTransaction", onTransaction)
  return count
}

async function expectQuiet(pa: { doc: Y.Doc }, pb: { doc: Y.Doc }, b: Editor) {
  let updates = 0
  let localOnB = 0
  const count = () => updates++
  const onB = ({ transaction }: { transaction: any }) => {
    if (transaction.docChanged && !isChangeOrigin(transaction)) localOnB++
  }
  pa.doc.on("update", count)
  pb.doc.on("update", count)
  b.on("transaction", onB)
  await new Promise((resolve) => setTimeout(resolve, 300))
  pa.doc.off("update", count)
  pb.doc.off("update", count)
  b.off("transaction", onB)
  expect(updates).toBe(0)
  expect(localOnB).toBe(0)
}

const stored = () => relay.api.posts.get(String(POST_ID))!.block_doc as BlockDocV1

describe("moving blocks between slots on the relay (#417)", () => {
  it("a drag into a group reaches the collaborator as one change, the block keeping its id", async () => {
    const { pa, pb, a, b } = await twoEditors()
    expect(localTransactions(pa.doc, () => drag(a, C, A, "after"))).toBe(1)
    await converged(a, b, "the move to reach b")
    expect(shape(b.state.doc)).toBe("group[alpha,gamma,beta],end")
    const group = b.state.doc.firstChild!
    expect(group.child(1).attrs["data-block-id"]).toBe(C)
    expect(unique(blockIds(a.state.doc))).toBe(true)
    expect(blockIds(a.state.doc)).toEqual(blockIds(b.state.doc))
    await expectQuiet(pa, pb, b)

    await waitFor(() => stored()?.blocks[GROUP]?.children?.length === 3, { what: "the store" })
    const doc = stored()
    expect(() => validateBlockDoc(doc)).not.toThrow()
    expect(doc.blocks[GROUP].children).toEqual([A, C, B])
    expect(doc.blocks_order.slice(0, 2)).toEqual([GROUP, END])
  })

  it("a drag out of a group (its last block takes the group along) is one change too", async () => {
    const { pa, a, b } = await twoEditors()
    drag(a, A, C, "after")
    await converged(a, b, "the first move")
    expect(localTransactions(pa.doc, () => drag(a, B, END, "before"))).toBe(1)
    await converged(a, b, "the second move")
    expect(shape(b.state.doc)).toBe("gamma,alpha,beta,end")
    await waitFor(() => !stored()?.blocks[GROUP] && stored()?.blocks_order.length === 4, { what: "the store" })
    expect(stored().blocks_order).toEqual([C, A, B, END])
  })

  it("is one undo step, for the person who moved it and for the collaborator", async () => {
    const { a, b } = await twoEditors()
    const before = shape(a.state.doc)
    drag(a, C, B, "after")
    await converged(a, b, "the move")
    expect(shape(b.state.doc)).toBe("group[alpha,beta,gamma],end")
    expect(a.commands.undo()).toBe(true)
    await converged(a, b, "the undo")
    expect(shape(a.state.doc)).toBe(before)
    expect(shape(b.state.doc)).toBe(before)
    expect(blockIds(b.state.doc).filter((id) => id !== null)).toContain(C)
  })

  it("two people moving the same block at once get two copies, with distinct ids, and lose nothing", async () => {
    const { pa, pb, a, b } = await twoEditors()
    // At the same time: A drags "gamma" into the group, B drags it below "end".
    drag(a, C, A, "before")
    drag(b, C, END, "after")
    await waitFor(() => json(a) === json(b) && (a.getText().match(/gamma/g)?.length ?? 0) === 2, { what: "both moves everywhere" })
    expect(shape(a.state.doc)).toBe("group[gamma,alpha,beta],end,gamma")
    // The copies share the moved block's id until the server's stamping (rule 7: neither
    // editor re-stamps a synced change) gives one of them a new one, in the live doc.
    await waitFor(() => unique(blockIds(a.state.doc)) && unique(blockIds(b.state.doc)) && json(a) === json(b), {
      what: "distinct ids on both peers",
    })
    const ids = blockIds(a.state.doc)
    expect(ids).toContain(C)
    for (const id of [GROUP, A, B, END]) expect(ids).toContain(id)
    await expectQuiet(pa, pb, b)

    await waitFor(() => (stored()?.blocks_order.length ?? 0) === 3 && stored()?.blocks[GROUP]?.children?.length === 3, { what: "the store" })
    const doc = stored()
    expect(() => validateBlockDoc(doc)).not.toThrow()
    const texts = Object.values(doc.blocks).map((block) => (block.attrs as { text?: string }).text)
    expect(texts.filter((text) => text === "gamma")).toHaveLength(2)
    for (const text of ["alpha", "beta", "end"]) expect(texts).toContain(text)
  })

  it("a selected block that a collaborator deletes leaves a caret, and the sync goes on", async () => {
    const { a, b } = await twoEditors()
    // A selects "beta" (Esc), the last block of the group; B deletes it.
    const select = (editor: Editor, id: string) =>
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, editorBlockById(editor.state.doc, id)!.pos)))
    select(a, B)
    const beta = editorBlockById(b.state.doc, B)!
    b.view.dispatch(b.state.tr.delete(beta.pos, beta.pos + beta.node.nodeSize))
    await converged(a, b, "the delete to reach a")
    expect(shape(a.state.doc)).toBe("group[alpha],gamma,end")
    expect(a.state.selection).not.toBeInstanceOf(NodeSelection)
    // A selected block that is still there stays selected through others' edits.
    select(a, C)
    b.commands.insertContentAt(b.state.doc.content.size - 1, "!")
    await converged(a, b, "b's typing")
    expect((a.state.selection as NodeSelection).node?.attrs["data-block-id"]).toBe(C)
    // And a's own edits still reach b.
    a.commands.insertContentAt(1 + 1, "A")
    await converged(a, b, "a's typing")
    expect(b.getText()).toContain("Aalpha")
  })

  it("⌘⇧↓ inside a group is one change that reaches the collaborator, ids kept", async () => {
    const { pa, a, b } = await twoEditors()
    let inAlpha = -1
    a.state.doc.descendants((node, pos) => {
      if (inAlpha === -1 && node.isText && node.text === "alpha") inAlpha = pos + 1
    })
    a.commands.setTextSelection(inAlpha)
    const event = new KeyboardEvent("keydown", { key: "ArrowDown", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })
    expect(localTransactions(pa.doc, () => a.view.someProp("handleKeyDown", (f) => f(a.view, event)))).toBe(1)
    await converged(a, b, "the move")
    expect(shape(b.state.doc)).toBe("group[beta,alpha],gamma,end")
    expect(b.state.doc.firstChild!.child(1).attrs["data-block-id"]).toBe(A)
  })
})
