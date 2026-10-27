import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import Collaboration from "@tiptap/extension-collaboration"
import { BlockIdExtension } from "@gl-admin/components/editor/extensions/BlockIdExtension"
import { paragraphDoc, paragraphs } from "../../../collab-server/testkit"
import type { BlockDocV1 } from "../blocks-spec"
import { canonical } from "./fragmentBridge.fixtures"
import { CollabSaveStatus } from "./CollabSaveStatus"
import { META_MAP, type HocuspocusCollaboration, type StoreMessage } from "./HocuspocusCollaboration"
import { restoreVersionLive } from "./liveRestore"
import { startRelay, waitFor, type Relay } from "./hocuspocusRelay.testkit"
import { textOf } from "./testHelpers"

// Restoring a version (#136, rule 9; #206): through the editor,
// then the server's store persists it. No PUT, no forceSave.

let relay: Relay
const editors: Editor[] = []

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  relay = await startRelay({ blockDoc: canonical(paragraphDoc("current one", "current two")), revision: 4 })
})

afterEach(async () => {
  while (editors.length) editors.pop()!.destroy()
  await relay.destroy()
  vi.restoreAllMocks()
})

async function peer(userId: string): Promise<{ editor: Editor; collab: HocuspocusCollaboration; status: CollabSaveStatus }> {
  const collab = relay.client(userId)
  await collab.whenSynced()
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [StarterKit.configure({ undoRedo: false }), BlockIdExtension, Collaboration.configure({ document: collab.doc })],
  })
  editors.push(editor)
  return { editor, collab, status: new CollabSaveStatus(collab) }
}

const stored = () => relay.api.posts.get("12")!.block_doc!

/** A stored version: two paragraphs and an empty code block, which the editor can't show (#213). */
function versionDoc(): BlockDocV1 {
  return {
    doc_version: 1,
    blocks_order: ["blk-version-0001", "blk-version-code", "blk-version-0002"],
    blocks: {
      "blk-version-0001": { id: "blk-version-0001", type: "paragraph", version: 1, attrs: { text: "version one" } },
      "blk-version-code": { id: "blk-version-code", type: "code_block", version: 1, attrs: { code: "" } },
      "blk-version-0002": { id: "blk-version-0002", type: "paragraph", version: 1, attrs: { text: "version two" } },
    },
  } as BlockDocV1
}

describe("restoreVersionLive", () => {
  it("restores through the editor, reaches the peer, and resolves once the server stored it", async () => {
    const a = await peer("1")
    const b = await peer("2")

    const result = await restoreVersionLive(a.editor, versionDoc(), a.collab.doc, a.status)
    expect(result).toEqual({ saved: true, dropped: 1 })

    // The store that resolved it already holds the restored content…
    expect(stored().blocks_order.map((id) => textOf(stored().blocks[id]) ?? stored().blocks[id].type)).toEqual([
      "version one",
      "code_block",
      "version two",
    ])
    // …with the block the editor can't show merged back from meta.dropped (hidden, not deleted).
    expect(stored().blocks["blk-version-code"].type).toBe("code_block")
    expect((a.collab.doc.getMap(META_MAP).get("dropped") as { entries: unknown[] }).entries).toHaveLength(1)

    // The peer got it as an ordinary edit.
    await waitFor(() => paragraphs(b.collab.doc).join("|") === "version one|version two", { what: "the peer" })
    expect(b.editor.getText()).toContain("version two")
  })

  it("replaces a stale dropped-block record when the version has none", async () => {
    const a = await peer("1")
    a.collab.doc.getMap(META_MAP).set("dropped", { entries: [{ id: "blk-gone-00001", parentId: null, afterId: null }], blocks: {} })
    await restoreVersionLive(a.editor, canonical(paragraphDoc("plain version")), a.collab.doc, a.status)
    expect(a.collab.doc.getMap(META_MAP).has("dropped")).toBe(false)
    expect(stored().blocks_order.map((id) => textOf(stored().blocks[id]))).toEqual(["plain version"])
  })

  it("reports { saved: false } when no store is confirmed in time, and rejects a failed store", async () => {
    const a = await peer("1")
    relay.api.failPut = true
    const failed = restoreVersionLive(a.editor, canonical(paragraphDoc("will fail")), a.collab.doc, a.status)
    await expect(failed).rejects.toMatchObject({ kind: "failed" })

    relay.api.failPut = false
    // A doc that never answers: a fake source whose store never comes.
    const silent = new CollabSaveStatus({
      doc: a.collab.doc,
      provider: { hasUnsyncedChanges: false, on: () => {}, off: () => {} },
      onStore: (_listener: (message: StoreMessage) => void) => () => {},
    })
    const result = await restoreVersionLive(a.editor, canonical(paragraphDoc("slow")), a.collab.doc, silent, { timeoutMs: 50 })
    expect(result.saved).toBe(false)
    silent.destroy()
  })

  it("refuses a read-only editor", async () => {
    const a = await peer("1")
    a.editor.setEditable(false)
    await expect(restoreVersionLive(a.editor, versionDoc(), a.collab.doc, a.status)).rejects.toThrow(/read-only/)
  })
})
