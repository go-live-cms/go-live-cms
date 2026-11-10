import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import * as Y from "yjs"
import { Editor } from "@tiptap/core"
import Collaboration from "@tiptap/extension-collaboration"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { canonical } from "@gl-admin/lib/collaboration/fragmentBridge.fixtures"
import { startRelay, waitFor, type Relay } from "@gl-admin/lib/collaboration/hocuspocusRelay.testkit"
import { validateBlockDoc, type BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { planBlockMove, dropTargetFor, editorBlockById } from "../utils/blockTree"
import { applyBlockMove } from "../utils/blockMoveSync"

// Custom HTML on the real collab server (#428). A client that ignores the editor's UI can
// write anything into the shared doc, so these drive the Yjs doc directly: a block with
// inline markup, and one naming another post's snippet. Only an id ever reaches the store.
// An editor who can't change the markup can still move the block, and its id goes with it.

const editors: Editor[] = []
let relay: Relay

function makeEditor(doc: Y.Doc): Editor {
  const element = document.createElement("div")
  document.body.appendChild(element)
  const editor = new Editor({ element, extensions: [...Object.values(schemaExtensions({ collaborating: true })), Collaboration.configure({ document: doc })] })
  editors.push(editor)
  return editor
}

const BLOCK = "blk-0428-html-0000001"
const AFTER = "blk-0428-after-000001"
const NEW_BLOCK = "blk-0428-rogue-000001"
const SNIPPET = "11111111-1111-4111-8111-111111111111"
const FOREIGN = "99999999-9999-4999-8999-999999999999"

const seed: BlockDocV1 = {
  doc_version: 1,
  blocks_order: [BLOCK, AFTER],
  blocks: {
    [BLOCK]: { id: BLOCK, type: "html", version: 1, attrs: { snippetId: SNIPPET } },
    [AFTER]: { id: AFTER, type: "paragraph", version: 1, attrs: { text: "after" } },
  },
}

describe("custom HTML on the relay (#428)", () => {
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

  const stored = () => relay.api.posts.get("12")!.block_doc!

  it("a client writing the doc directly gets markup nowhere: a new block and a changed one", async () => {
    const pa = relay.client("1")
    await pa.whenSynced()
    const fragment = pa.doc.getXmlFragment("default")
    expect((fragment.get(0) as Y.XmlElement).nodeName).toBe("html")

    pa.doc.transact(() => {
      // A new block with inline markup, naming another post's snippet.
      const rogue = new Y.XmlElement("html")
      rogue.setAttribute("data-block-id", NEW_BLOCK)
      rogue.setAttribute("snippetId", FOREIGN)
      rogue.setAttribute("html", "<script>alert(1)</script>")
      fragment.insert(0, [rogue])
      // And markup added to the block that exists.
      const existing = fragment.get(1) as Y.XmlElement
      existing.setAttribute("html", "<img src=x onerror=alert(2)>")
      existing.setAttribute("onmouseover", "alert(3)")
    })

    await waitFor(() => !!stored().blocks[NEW_BLOCK], { what: "the store" })
    const doc = stored()
    expect(doc.blocks[NEW_BLOCK]).toEqual({ id: NEW_BLOCK, type: "html", version: 1, attrs: { snippetId: FOREIGN } })
    expect(doc.blocks[BLOCK]).toEqual({ id: BLOCK, type: "html", version: 1, attrs: { snippetId: SNIPPET } })
    expect(JSON.stringify(doc)).not.toMatch(/script|onerror|onmouseover/)
    expect(() => validateBlockDoc(doc)).not.toThrow()
  })

  it("moving the block keeps its id, for everyone", async () => {
    const pa = relay.client("1")
    const pb = relay.client("2")
    await Promise.all([pa.whenSynced(), pb.whenSynced()])
    const a = makeEditor(pa.doc)
    const b = makeEditor(pb.doc)
    await waitFor(() => b.getText().includes("after"), { what: "b to load" })

    const { state } = a
    const dragged = editorBlockById(state.doc, BLOCK)!
    const target = dropTargetFor(state.doc, dragged, editorBlockById(state.doc, AFTER)!, "after")!
    const move = planBlockMove(state, dragged, target)!
    applyBlockMove(a.view, move)

    await waitFor(() => b.state.doc.child(1).type.name === "html", { what: "b to see the move" })
    expect(b.state.doc.child(1).attrs).toMatchObject({ "data-block-id": BLOCK, snippetId: SNIPPET })

    await waitFor(() => stored().blocks_order[1] === BLOCK, { what: "the store" })
    expect(stored().blocks[BLOCK].attrs).toEqual({ snippetId: SNIPPET })
  })

  it("survives a collab server restart", async () => {
    const pa = relay.client("1")
    await pa.whenSynced()
    const a = makeEditor(pa.doc)
    await waitFor(() => a.getText().includes("after"), { what: "a to load" })
    const node = a.state.doc.child(0)
    a.view.dispatch(a.state.tr.setNodeMarkup(0, undefined, { ...node.attrs, snippetId: FOREIGN }))
    await waitFor(() => (stored().blocks[BLOCK]?.attrs as { snippetId?: string }).snippetId === FOREIGN, { what: "the store" })

    await relay.restart()
    const pb = relay.client("2")
    await pb.whenSynced()
    const b = makeEditor(pb.doc)
    await waitFor(() => b.getText().includes("after"), { what: "b to load after the restart" })
    expect(b.state.doc.child(0).attrs).toMatchObject({ "data-block-id": BLOCK, snippetId: FOREIGN })
  })
})
