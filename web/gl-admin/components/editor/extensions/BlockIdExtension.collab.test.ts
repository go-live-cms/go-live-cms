import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import Collaboration, { isChangeOrigin } from "@tiptap/extension-collaboration"
import { BlockIdExtension } from "./BlockIdExtension"
import { paragraphDoc } from "../../../../collab-server/testkit"
import { canonical } from "@gl-admin/lib/collaboration/fragmentBridge.fixtures"
import type { HocuspocusCollaboration } from "@gl-admin/lib/collaboration/HocuspocusCollaboration"
import { startRelay, waitFor, type Relay } from "@gl-admin/lib/collaboration/hocuspocusRelay.testkit"

// BlockIdExtension between two editors on the Hocuspocus relay (#206 P3, #283; rule 7):
// the structural edits that wedged the old server (Enter-split, paragraph → heading, list
// toggles) give every node a unique id on the peer that made it, the other peer takes
// them as they are (no re-stamping, no loop), and the server stores those same ids.

let relay: Relay
const editors: Editor[] = []

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  relay = await startRelay({ blockDoc: canonical(paragraphDoc("first paragraph", "second")), revision: 2 })
})

afterEach(async () => {
  while (editors.length) editors.pop()!.destroy()
  await relay.destroy()
  vi.restoreAllMocks()
})

async function peer(userId: string): Promise<{ editor: Editor; collab: HocuspocusCollaboration }> {
  const collab = relay.client(userId)
  await collab.whenSynced()
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [StarterKit.configure({ undoRedo: false }), BlockIdExtension, Collaboration.configure({ document: collab.doc })],
  })
  editors.push(editor)
  return { editor, collab }
}

/**
 * The ids BlockIdExtension keeps unique, in document order: top-level nodes and list
 * items (#238). A paragraph inside a list item keeps whatever it had (not a block).
 */
function ids(editor: Editor): string[] {
  const out: string[] = []
  editor.state.doc.descendants((node, _pos, parent) => {
    if (parent === editor.state.doc || node.type.name === "listItem") out.push(node.attrs["data-block-id"])
  })
  return out
}

function countLocalChanges(editor: Editor) {
  const counter = { changes: 0 }
  editor.on("transaction", ({ transaction, appendedTransactions }) => {
    for (const tr of [transaction, ...(appendedTransactions ?? [])]) {
      if (tr.docChanged && !isChangeOrigin(tr)) counter.changes++
    }
  })
  return counter
}

const same = (a: Editor, b: Editor) => JSON.stringify(a.state.doc.toJSON()) === JSON.stringify(b.state.doc.toJSON())

describe("BlockIdExtension on the Hocuspocus relay", () => {
  it("Enter-split, paragraph → heading and a list toggle converge with unique ids, without a loop", async () => {
    const { editor: a, collab: ca } = await peer("1")
    const { editor: b, collab: cb } = await peer("2")
    await waitFor(() => same(a, b), { what: "both editors to show the seed" })
    const onB = countLocalChanges(b)

    // Enter in the middle of "first paragraph": the new node copies the id, BlockId
    // must give it a fresh one.
    a.commands.setTextSelection(7)
    a.commands.splitBlock()
    a.commands.setNode("heading", { level: 2 })
    a.commands.setTextSelection(a.state.doc.content.size - 1)
    a.commands.toggleBulletList()
    a.commands.splitListItem("listItem")
    a.commands.insertContent("item two")

    await waitFor(() => same(a, b), { what: "convergence" })
    const all = ids(a)
    expect(all.every((id) => typeof id === "string" && id.length >= 10)).toBe(true)
    expect(new Set(all).size).toBe(all.length)
    expect(ids(b)).toEqual(all)

    // Quiet afterwards, and b never stamped anything itself.
    let updates = 0
    const count = () => updates++
    ca.doc.on("update", count)
    cb.doc.on("update", count)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(updates).toBe(0)
    expect(onB.changes).toBe(0)

    // The server stores the editor's ids, and a second store changes none of them.
    const topLevel: string[] = []
    a.state.doc.forEach((node) => topLevel.push(node.attrs["data-block-id"]))
    await waitFor(() => JSON.stringify(relay.api.posts.get("12")!.block_doc!.blocks_order) === JSON.stringify(topLevel), {
      what: "the store",
    })
    const revision = relay.api.posts.get("12")!.block_revision
    await relay.server.flush("post-12")
    expect(relay.api.posts.get("12")!.block_revision).toBe(revision)
  })
})
