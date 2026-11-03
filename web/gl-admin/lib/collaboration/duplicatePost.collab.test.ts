import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import * as Y from "yjs"
import { Editor } from "@tiptap/core"
import Collaboration from "@tiptap/extension-collaboration"
import { schemaExtensions } from "./schema"
import { POST_ID, startRelay, waitFor, type Relay } from "./hocuspocusRelay.testkit"
import { installedThemeBlocks } from "../theme-blocks/installed"
import type { BlockDocV1 } from "../blocks-spec"
import vectors from "./duplicatePost.vectors.json"

// Duplicating a post (#354) on the real collab server (in process). The API copies the
// source's working copy into the new post's block_doc with new block ids and never
// copies its Yjs state, so the copy has a block_doc and no ydoc_state: the server's
// ordinary load path seeds it (the same path as a new post created with a body, #283),
// and two users then edit it like any other post. The docs are the Go test's
// (TestDuplicatePostVectors checks `duplicate` follows the API's rules).

const source = vectors.source as unknown as BlockDocV1
const duplicate = vectors.duplicate as unknown as BlockDocV1
const COPY_ID = 13

const editors: Editor[] = []

function makeEditor(doc: Y.Doc): Editor {
  const element = document.createElement("div")
  document.body.appendChild(element)
  const editor = new Editor({
    element,
    extensions: [
      ...Object.values(schemaExtensions({ collaborating: true })),
      ...installedThemeBlocks.map((block) => block.node),
      Collaboration.configure({ document: doc }),
    ],
  })
  editors.push(editor)
  return editor
}

// Every data-block-id in the editor's doc, top-level nodes and list items.
function blockIds(editor: Editor): string[] {
  const ids: string[] = []
  editor.state.doc.descendants((node) => {
    const id = node.attrs["data-block-id"]
    if (typeof id === "string") ids.push(id)
  })
  return ids
}

const sourceIds = Object.keys(source.blocks)

describe("a duplicated post on the Hocuspocus relay (#354)", () => {
  let relay: Relay
  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    relay = await startRelay({ blockDoc: source, revision: 3 })
  })
  afterEach(async () => {
    while (editors.length) editors.pop()!.destroy()
    await relay.destroy()
    vi.restoreAllMocks()
  })

  it("seeds the copy from its block_doc, and two users edit it without touching the source", async () => {
    // The source is live and has stored Yjs state of its own.
    const ps = relay.client("1")
    await ps.whenSynced()
    const s = makeEditor(ps.doc)
    await waitFor(() => s.getText().includes("The end"), { what: "the source to load" })
    s.commands.insertContentAt(s.state.doc.content.size - 1, " (source edit)")
    await waitFor(() => JSON.stringify(relay.api.posts.get(String(POST_ID))!.block_doc).includes("(source edit)"), {
      what: "the source's store",
    })
    const sourceAfter = structuredClone(relay.api.posts.get(String(POST_ID))!)
    expect(sourceAfter.state).not.toBeNull()

    // What POST /posts/:id/duplicate leaves: a block_doc, no ydoc_state.
    relay.api.addPost(String(COPY_ID), duplicate, 1)
    expect(relay.api.posts.get(String(COPY_ID))!.state).toBeNull()

    const pa = relay.client("1", { postId: COPY_ID })
    const pb = relay.client("2", { postId: COPY_ID })
    await Promise.all([pa.whenSynced(), pb.whenSynced()])
    const a = makeEditor(pa.doc)
    const b = makeEditor(pb.doc)
    await waitFor(() => a.getText().includes("The end") && b.getText().includes("The end"), { what: "both to load the copy" })

    // Seeded by the server from block_doc: the source's content under the copy's ids,
    // under a new epoch of its own, and the seed stored at once (state only).
    for (const text of ["Plain and bold", "A heading", "The caption", "First item", "Second item", "The end"]) {
      expect(a.getText()).toContain(text)
    }
    expect(a.getText()).not.toContain("(source edit)")
    const ids = blockIds(a)
    expect(ids.slice(0, 1)).toEqual([duplicate.blocks_order[0]])
    for (const id of duplicate.blocks_order) expect(ids).toContain(id)
    for (const id of sourceIds) expect(ids).not.toContain(id)
    expect(blockIds(b)).toEqual(ids)
    const epoch = pa.doc.getMap("meta").get("epoch")
    expect(typeof epoch).toBe("string")
    expect(epoch).not.toBe(ps.doc.getMap("meta").get("epoch"))
    await waitFor(() => relay.api.puts.some((put) => put.postId === String(COPY_ID)), { what: "the seed store" })
    const seed = relay.api.puts.find((put) => put.postId === String(COPY_ID))!
    expect(seed.body.block_doc).toBeUndefined()

    // Both users edit; both see both edits, and the store has them under the copy's ids.
    a.commands.insertContentAt(1, "A says hi. ")
    b.commands.insertContentAt(b.state.doc.content.size - 1, " B too.")
    await waitFor(() => a.getText().includes("B too.") && b.getText().includes("A says hi."), { what: "each other's edits" })
    await waitFor(() => JSON.stringify(b.state.doc.toJSON()) === JSON.stringify(a.state.doc.toJSON()), { what: "convergence" })

    const stored = () => relay.api.posts.get(String(COPY_ID))!.block_doc!
    await waitFor(() => JSON.stringify(stored()).includes("A says hi.") && JSON.stringify(stored()).includes("B too."), {
      what: "the copy's store",
    })
    const doc = stored()
    expect(doc.blocks_order.slice(0, duplicate.blocks_order.length)).toEqual(duplicate.blocks_order)
    for (const id of sourceIds) expect(JSON.stringify(doc)).not.toContain(id)

    // The source is untouched by all of it.
    expect(relay.api.posts.get(String(POST_ID))).toEqual(sourceAfter)
    expect(s.getText()).not.toContain("A says hi.")
  })
})
