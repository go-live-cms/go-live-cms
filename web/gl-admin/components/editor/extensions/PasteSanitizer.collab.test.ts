import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import * as Y from "yjs"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import Collaboration, { isChangeOrigin } from "@tiptap/extension-collaboration"
import { BlockIdExtension } from "./BlockIdExtension"
import { PasteSanitizer } from "./PasteSanitizer"
import googleDocsHTML from "./__fixtures__/paste/google-docs.html?raw"
import { paragraphDoc } from "../../../../collab-server/testkit"
import { canonical } from "@gl-admin/lib/collaboration/fragmentBridge.fixtures"
import { startRelay, waitFor, type Relay } from "@gl-admin/lib/collaboration/hocuspocusRelay.testkit"

// Two collaborators: each editor is bound (TipTap Collaboration / ySyncPlugin) to its
// own Y.Doc, and a relay forwards every update to the other doc, like the WS server.
// A paste on one side must reach the other with the same block ids, and then go
// quiet: no BlockId re-stamping on the receiving side bouncing back (rule 7).

const editors: Editor[] = []

afterEach(() => {
  while (editors.length) editors.pop()!.destroy()
})

function makePeer(doc: Y.Doc, { blockIds = true } = {}): Editor {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      ...(blockIds ? [BlockIdExtension] : []),
      PasteSanitizer,
      Collaboration.configure({ document: doc }),
    ],
  })
  editors.push(editor)
  return editor
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

async function settle() {
  for (let i = 0; i < 5; i++) await tick()
}

/** Two docs relaying every update to each other; returns a counter of all updates. */
function relay(docA: Y.Doc, docB: Y.Doc) {
  const counter = { updates: 0 }
  docA.on("update", (u: Uint8Array, origin: unknown) => {
    counter.updates++
    if (origin !== "relay") Y.applyUpdate(docB, u, "relay")
  })
  docB.on("update", (u: Uint8Array, origin: unknown) => {
    counter.updates++
    if (origin !== "relay") Y.applyUpdate(docA, u, "relay")
  })
  return counter
}

/** Counts doc changes the editor makes on its own (not applied from Yjs), appended ones included. */
function countLocalChanges(editor: Editor) {
  const counter = { changes: 0 }
  editor.on("transaction", ({ transaction, appendedTransactions }) => {
    for (const tr of [transaction, ...(appendedTransactions ?? [])]) {
      if (tr.docChanged && !isChangeOrigin(tr)) counter.changes++
    }
  })
  return counter
}

describe("PasteSanitizer with collaboration (#128)", () => {
  it("a paste syncs to the other peer with the same ids and doesn't loop", async () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const relayed = relay(docA, docB)
    const a = makePeer(docA)
    const b = makePeer(docB)
    await settle()
    const onB = countLocalChanges(b)

    a.view.pasteHTML(googleDocsHTML, new Event("paste") as ClipboardEvent)
    await settle()

    expect(a.getText()).toContain("twelve percent")
    expect(b.state.doc.toJSON()).toEqual(a.state.doc.toJSON())
    a.state.doc.forEach((node) => {
      expect(typeof node.attrs["data-block-id"]).toBe("string")
    })

    // Quiescent: a full resync both ways (the 2s resyncInterval) changes nothing.
    const before = relayed.updates
    for (let i = 0; i < 3; i++) {
      Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA), "relay")
      Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB), "relay")
      await settle()
    }
    expect(relayed.updates).toBe(before)
    expect(onB.changes).toBe(0)
    expect(b.state.doc.toJSON()).toEqual(a.state.doc.toJSON())
  })

  it("the receiving peer doesn't stamp ids on pasted content that arrives without them (rule 7)", async () => {
    // The sender stamps ids in the same state update as the paste, so normally they
    // arrive with the content. A sender without BlockIdExtension sends id-less nodes:
    // the receiver must leave them alone (pmToBlockDoc backfills at save time). A
    // local re-stamp is a new change that bounces back to the sender and loops.
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    relay(docA, docB)
    const a = makePeer(docA, { blockIds: false })
    const b = makePeer(docB)
    await settle()
    const onB = countLocalChanges(b)

    a.view.pasteHTML("<h2>Pasted</h2><ul><li>one</li><li>two</li></ul><p>end</p>", new Event("paste") as ClipboardEvent)
    await settle()

    expect(b.getText()).toContain("Pasted")
    expect(onB.changes).toBe(0)
    // Not toJSON(): A's schema has no data-block-id attr at all, B's has it as null.
    expect(b.getText()).toBe(a.getText())
  })
})
// The same, with the real Hocuspocus server as the relay (#206 P3, #283): each editor is
// bound to the doc of the editor's own provider (HocuspocusCollaboration), the server
// seeded the doc, and it stores block_doc from it.
describe("PasteSanitizer with collaboration, on the Hocuspocus relay", () => {
  let relay: Relay
  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    relay = await startRelay({ blockDoc: canonical(paragraphDoc("start")), revision: 2 })
  })
  afterEach(async () => {
    while (editors.length) editors.pop()!.destroy()
    await relay.destroy()
    vi.restoreAllMocks()
  })

  it("a paste reaches the other peer and the stored block_doc with the same ids, and goes quiet", async () => {
    const pa = relay.client("1")
    const pb = relay.client("2")
    await Promise.all([pa.whenSynced(), pb.whenSynced()])
    const a = makePeer(pa.doc)
    const b = makePeer(pb.doc)
    await settle()
    expect(b.getText()).toBe("start")
    const onB = countLocalChanges(b)

    a.commands.focus("end")
    a.view.pasteHTML(googleDocsHTML, new Event("paste") as ClipboardEvent)
    await waitFor(() => b.getText().includes("twelve percent"), { what: "the paste to reach b" })
    await waitFor(() => JSON.stringify(b.state.doc.toJSON()) === JSON.stringify(a.state.doc.toJSON()), {
      what: "convergence",
    })

    // Quiet: no more updates once converged (no re-stamping loop between the peers).
    let updates = 0
    const count = () => updates++
    pa.doc.on("update", count)
    pb.doc.on("update", count)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(onB.changes).toBe(0)
    expect(updates).toBe(0)

    // The server stored the editor's ids (it stamps only nodes without one).
    const ids = (editor: Editor) => {
      const out: string[] = []
      editor.state.doc.forEach((node) => out.push(node.attrs["data-block-id"]))
      return out
    }
    await waitFor(() => relay.api.posts.get("12")!.block_doc!.blocks_order.length === a.state.doc.childCount, {
      what: "the store",
    })
    expect(relay.api.posts.get("12")!.block_doc!.blocks_order).toEqual(ids(a))
  })
})
