import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as Y from "yjs"
import { BlockDocManager } from "./BlockDocManager"
import type { Block, BlockDocV1 } from "../blocks-spec"
import { getSchema } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { BlockIdExtension } from "@gl-admin/components/editor/extensions/BlockIdExtension"
import { pmToBlockDoc, synthesizedItemId } from "./blockBridge"

// --- Mock the API client module BEFORE importing the manager. ---------------
// ConflictError / UnauthorizedError must be real classes so the manager's
// `instanceof` checks work against errors we throw from the mock.
vi.mock("../api/blockAPI", () => {
  class ConflictError extends Error {}
  class UnauthorizedError extends Error {}
  return {
    ConflictError,
    UnauthorizedError,
    blockAPIClient: {
      setAuthToken: vi.fn(),
      getPostBlocks: vi.fn(),
      updatePostBlocks: vi.fn(),
      publishPost: vi.fn(),
    },
  }
})

import { BlockPersistenceManager } from "./BlockPersistenceManager"
import { blockAPIClient, ConflictError, UnauthorizedError } from "../api/blockAPI"

const api = blockAPIClient as unknown as {
  setAuthToken: ReturnType<typeof vi.fn>
  getPostBlocks: ReturnType<typeof vi.fn>
  updatePostBlocks: ReturnType<typeof vi.fn>
  publishPost: ReturnType<typeof vi.fn>
}

let counter = 0
const id = () => `blk-${(counter++).toString().padStart(4, "0")}-0000000000`

const oneBlockDoc = (text = "content"): BlockDocV1 => {
  const b: Block = { id: id(), type: "paragraph", version: 1, attrs: { text } }
  return { doc_version: 1, blocks_order: [b.id], blocks: { [b.id]: b } }
}
const emptyDoc = (): BlockDocV1 => ({ doc_version: 1, blocks_order: [], blocks: {} })

/** Build a manager over a real BlockDocManager, with a no-op sync callback. */
function makeManager(opts?: { title?: string }) {
  const blockDocManager = new BlockDocManager(new Y.Doc())
  const manager = new BlockPersistenceManager(1, blockDocManager, "tok", opts?.title)
  // syncFromEditor mirrors editor → BlockDoc; default is a no-op so the doc stays
  // whatever the API/test seeded. Individual tests can override.
  const syncFromEditor = vi.fn()
  manager.setSyncCallback(syncFromEditor)
  return { manager, blockDocManager, syncFromEditor }
}

/** Run initialize() and clear the 500ms isInitializing latch. */
async function activate(manager: BlockPersistenceManager) {
  await manager.initialize()
  await vi.advanceTimersByTimeAsync(500)
}

beforeEach(() => {
  vi.useFakeTimers()
  api.setAuthToken.mockReset()
  api.getPostBlocks.mockReset()
  api.updatePostBlocks.mockReset()
  api.publishPost.mockReset()
  // sensible defaults
  api.getPostBlocks.mockResolvedValue({ doc: oneBlockDoc(), revision: 1 })
  api.updatePostBlocks.mockImplementation(async (_id, doc) => ({ doc, revision: 2 }))
})

afterEach(() => {
  vi.useRealTimers()
})

describe("initialize()", () => {
  it("loads the document and is idempotent on success", async () => {
    const { manager } = makeManager()
    await activate(manager)
    expect(api.getPostBlocks).toHaveBeenCalledTimes(1)
    expect(manager.getCurrentRevision()).toBe(1)

    await manager.initialize() // second call should no-op
    expect(api.getPostBlocks).toHaveBeenCalledTimes(1)
  })

  it("does NOT latch on a failed load — a later initialize() can retry", async () => {
    const { manager } = makeManager()
    api.getPostBlocks.mockRejectedValueOnce(new Error("network blip"))

    await manager.initialize() // fails
    await vi.advanceTimersByTimeAsync(500)
    expect(api.getPostBlocks).toHaveBeenCalledTimes(1)

    // retry succeeds
    api.getPostBlocks.mockResolvedValueOnce({ doc: oneBlockDoc(), revision: 5 })
    await manager.initialize()
    expect(api.getPostBlocks).toHaveBeenCalledTimes(2)
    expect(manager.getCurrentRevision()).toBe(5)
  })

  it("releases the isInitializing latch even when the load fails (autosave can run)", async () => {
    const { manager } = makeManager()
    api.getPostBlocks.mockRejectedValueOnce(new Error("boom"))
    await manager.initialize()
    await vi.advanceTimersByTimeAsync(500)
    expect(manager.isCurrentlyInitializing()).toBe(false)
  })

  it("suspends on an Unauthorized load error", async () => {
    const { manager } = makeManager()
    const onSaveError = vi.fn()
    manager.setCallbacks({ onSaveError })
    api.getPostBlocks.mockRejectedValueOnce(new UnauthorizedError("401"))

    await manager.initialize()
    await vi.advanceTimersByTimeAsync(500)
    expect(onSaveError).toHaveBeenCalled()
  })
})

describe("warm reload — does not overwrite an already-populated Yjs doc", () => {
  it("keeps live Yjs content and ignores the REST working copy when the doc is non-empty", async () => {
    // Simulate a warm reload: IndexedDB + the WS server have already restored content
    // into the collaborative doc BEFORE the REST load runs.
    const blockDocManager = new BlockDocManager(new Y.Doc())
    blockDocManager.setBlockDocV1(oneBlockDoc("live-yjs-content"))

    const manager = new BlockPersistenceManager(1, blockDocManager, "tok")
    manager.setSyncCallback(vi.fn())

    // The REST working copy returns DIFFERENT (older) content.
    api.getPostBlocks.mockResolvedValueOnce({ doc: oneBlockDoc("stale-rest-content"), revision: 3 })
    await manager.initialize()
    await vi.advanceTimersByTimeAsync(500)

    // The live Yjs content must be preserved — overwriting it via setBlockDocV1/
    // setContent is what caused the reload "heartbeat" (a competing parallel state
    // the resync then fights). Revision is still adopted from the load.
    const after = blockDocManager.getBlockDocV1()
    const texts = after.blocks_order.map((bid) => (after.blocks[bid].attrs as { text?: string }).text)
    expect(texts).toContain("live-yjs-content")
    expect(texts).not.toContain("stale-rest-content")
    expect(manager.getCurrentRevision()).toBe(3)
  })

  it("DOES seed from REST when the Yjs doc is empty (cold start)", async () => {
    const blockDocManager = new BlockDocManager(new Y.Doc()) // empty
    const manager = new BlockPersistenceManager(1, blockDocManager, "tok")
    manager.setSyncCallback(vi.fn())

    api.getPostBlocks.mockResolvedValueOnce({ doc: oneBlockDoc("rest-content"), revision: 1 })
    await manager.initialize()
    await vi.advanceTimersByTimeAsync(500)

    const after = blockDocManager.getBlockDocV1()
    const texts = after.blocks_order.map((bid) => (after.blocks[bid].attrs as { text?: string }).text)
    expect(texts).toContain("rest-content")
  })
})

describe("autosave", () => {
  it("debounced edit triggers a save with the current doc", async () => {
    const { manager } = makeManager()
    await activate(manager)

    manager.notifyEditorChange()
    await vi.advanceTimersByTimeAsync(1500)

    expect(api.updatePostBlocks).toHaveBeenCalledTimes(1)
    expect(manager.getCurrentRevision()).toBe(2)
    expect(manager.hasUnsaved()).toBe(false)
  })

  it("mirrors the editor into the BlockDoc before each save", async () => {
    const { manager, syncFromEditor } = makeManager()
    await activate(manager)
    manager.notifyEditorChange()
    await vi.advanceTimersByTimeAsync(1500)
    expect(syncFromEditor).toHaveBeenCalled()
  })
})

describe("empty-document guard", () => {
  it("autosave SKIPS persisting a 0-block document", async () => {
    const { manager } = makeManager()
    api.getPostBlocks.mockResolvedValueOnce({ doc: emptyDoc(), revision: 1 })
    await activate(manager)

    manager.notifyEditorChange()
    await vi.advanceTimersByTimeAsync(1500)
    expect(api.updatePostBlocks).not.toHaveBeenCalled()
  })

  it("forceSave (explicit) MAY persist an empty document", async () => {
    const { manager } = makeManager()
    api.getPostBlocks.mockResolvedValueOnce({ doc: emptyDoc(), revision: 1 })
    await activate(manager)

    manager.notifyEditorChange() // sets hasUnsavedChanges
    await manager.forceSave()
    expect(api.updatePostBlocks).toHaveBeenCalledTimes(1)
  })
})

describe("in-flight edits are not dropped", () => {
  it("an edit during an in-flight save keeps hasUnsavedChanges and triggers a follow-up save", async () => {
    const { manager } = makeManager()
    await activate(manager)

    // First save: make the API call hang so we can edit mid-flight.
    let resolveFirst: (v: any) => void = () => {}
    api.updatePostBlocks.mockImplementationOnce(
      () => new Promise((res) => { resolveFirst = res })
    )

    manager.notifyEditorChange()
    await vi.advanceTimersByTimeAsync(1500) // performSave starts, awaits the hung API

    // Edit arrives WHILE the save is in flight.
    manager.notifyEditorChange()

    // Resolve the first save.
    resolveFirst({ doc: oneBlockDoc(), revision: 2 })
    await vi.advanceTimersByTimeAsync(0)

    // The mid-flight edit must not be lost: a follow-up save fires.
    await vi.advanceTimersByTimeAsync(1500)
    expect(api.updatePostBlocks).toHaveBeenCalledTimes(2)
    expect(manager.hasUnsaved()).toBe(false)
  })
})

describe("missed-timer recovery", () => {
  it("reschedules when a debounce timer fires INTO an in-flight save (consumed by the guard)", async () => {
    const { manager } = makeManager()
    await activate(manager)

    // Make the first save hang so the next debounce timer fires while isSaving=true.
    let resolveFirst: (v: any) => void = () => {}
    api.updatePostBlocks.mockImplementationOnce(
      () => new Promise((res) => { resolveFirst = res })
    )

    manager.notifyEditorChange()
    await vi.advanceTimersByTimeAsync(1500) // T1 fires → performSave hangs (isSaving=true)

    // Edit during the in-flight save schedules T2.
    manager.notifyEditorChange()
    // T2 fires while isSaving is still true → it's absorbed by performSave's guard.
    await vi.advanceTimersByTimeAsync(1500)
    expect(api.updatePostBlocks).toHaveBeenCalledTimes(1) // only the hung first save

    // Resolve the first save. The finally must reschedule because edits are still
    // pending and no live timer remains. (With the stale-saveTimer bug, the
    // recovery's `!saveTimer` check is false and the edit is silently dropped.)
    resolveFirst({ doc: oneBlockDoc(), revision: 2 })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1500) // recovery's debounce fires

    expect(api.updatePostBlocks).toHaveBeenCalledTimes(2)
    expect(manager.hasUnsaved()).toBe(false)
  })
})

describe("conflict (409) handling", () => {
  it("re-fetches latest and reconciles to the server copy (last-write-wins)", async () => {
    const { manager } = makeManager()
    const onConflictResolved = vi.fn()
    manager.setCallbacks({ onConflictResolved })
    await activate(manager)

    api.updatePostBlocks.mockRejectedValueOnce(new ConflictError("409"))
    api.getPostBlocks.mockResolvedValueOnce({ doc: oneBlockDoc("server"), revision: 9 })

    manager.notifyEditorChange()
    await vi.advanceTimersByTimeAsync(1500) // attempt → 409 → resolveConflict
    await vi.advanceTimersByTimeAsync(500) // retry timer fires
    await vi.advanceTimersByTimeAsync(0)

    // The failed attempt is the only PUT; the retry no-ops because resolveConflict
    // reconciled local→server and cleared the unsaved flag.
    expect(api.updatePostBlocks).toHaveBeenCalledTimes(1)
    // resolveConflict re-fetched latest (init load + conflict refetch = 2).
    expect(api.getPostBlocks).toHaveBeenCalledTimes(2)
    expect(onConflictResolved).toHaveBeenCalled()
    expect(manager.getCurrentRevision()).toBe(9)

    // ⚠️ DOCUMENTED BEHAVIOR (worth revisiting): on a 409 the local unsaved edit
    // is discarded in favour of the server copy. Fine for the current single-user
    // flow, but a real "client-wins"/merge strategy would re-apply local edits.
  })
})

describe("flag recovery — nothing latches autosave forever", () => {
  it("a throwing syncFromEditor does not leave isSaving stuck", async () => {
    const { manager, syncFromEditor } = makeManager()
    const onSaveError = vi.fn()
    manager.setCallbacks({ onSaveError })
    await activate(manager)

    syncFromEditor.mockImplementationOnce(() => {
      throw new Error("pmToBlockDoc blew up")
    })

    manager.notifyEditorChange()
    await vi.advanceTimersByTimeAsync(1500) // save attempt throws in the mirror
    expect(onSaveError).toHaveBeenCalled()
    expect(api.updatePostBlocks).not.toHaveBeenCalled()

    // A subsequent normal edit still saves — isSaving was released.
    manager.notifyEditorChange()
    await vi.advanceTimersByTimeAsync(1500)
    expect(api.updatePostBlocks).toHaveBeenCalledTimes(1)
  })

  it("recovers from an Unauthorized save once a new token arrives", async () => {
    const { manager } = makeManager()
    await activate(manager)

    api.updatePostBlocks.mockRejectedValueOnce(new UnauthorizedError("401"))
    manager.notifyEditorChange()
    await vi.advanceTimersByTimeAsync(1500) // suspends

    // While suspended, edits don't schedule saves.
    manager.notifyEditorChange()
    await vi.advanceTimersByTimeAsync(1500)
    expect(api.updatePostBlocks).toHaveBeenCalledTimes(1) // still just the failed attempt

    // New token → resume → pending changes flush.
    manager.setAuthToken("fresh-token")
    await vi.advanceTimersByTimeAsync(1500)
    expect(api.updatePostBlocks).toHaveBeenCalledTimes(2)
  })
})

describe("no echo loop on reconnect (WS-restart heartbeat)", () => {
  it("a blocks-map change that did NOT come from the editor does not trigger an autosave", async () => {
    const { manager, blockDocManager } = makeManager()
    await activate(manager)
    api.updatePostBlocks.mockClear()

    // Simulate the server echoing our own mirror churn back over the 2s resync:
    // a blocks-map mutation that did not originate from a local editor edit.
    // This must NOT schedule a save — otherwise mirror churn + echo form the
    // self-sustaining 2s save loop seen after a WS restart (revision climbing,
    // hasUnsavedChanges perpetually true, content erased).
    blockDocManager.insertBlockAtPosition(
      { id: id(), type: "paragraph", version: 1, attrs: { text: "echo" } },
      0
    )
    await vi.advanceTimersByTimeAsync(3000)

    expect(api.updatePostBlocks).not.toHaveBeenCalled()
  })

  it("REPEATED server echoes (the 2s resync) never trigger autosaves", async () => {
    // The actual heartbeat: after a WS restart the server reflected a blocks-map update
    // back to the client on every ~2s resync. With a doc-map autosave trigger, each echo
    // scheduled a save → PUT every ~2s, revision climbing, content erased. Model many
    // echoes over time and assert ZERO saves — the only legitimate autosave trigger is a
    // real editor edit (notifyEditorChange).
    const { manager, blockDocManager } = makeManager()
    await activate(manager)
    api.updatePostBlocks.mockClear()

    for (let i = 0; i < 6; i++) {
      blockDocManager.insertBlockAtPosition(
        { id: id(), type: "paragraph", version: 1, attrs: { text: `echo-${i}` } },
        0
      )
      await vi.advanceTimersByTimeAsync(2000) // one resync interval
    }

    expect(api.updatePostBlocks).not.toHaveBeenCalled()
    expect(manager.hasUnsaved()).toBe(false)
  })
})

describe("publish()", () => {
  it("force-saves then calls publishPost", async () => {
    const { manager } = makeManager()
    await activate(manager)
    api.publishPost.mockResolvedValueOnce({ versionId: 7, versionNo: 1 })

    manager.notifyEditorChange()
    const result = await manager.publish("label", "msg")

    expect(api.updatePostBlocks).toHaveBeenCalled() // forced save
    expect(api.publishPost).toHaveBeenCalledWith(1, "label", "msg")
    expect(result).toEqual({ versionId: 7, versionNo: 1 })
  })
})

// #213: blocks the editor can't hold are hidden from it, never deleted by a save.
describe("blocks dropped on load", () => {
  const schema = getSchema([StarterKit, BlockIdExtension])

  /** A minimal stand-in for the TipTap editor: real schema, records setContent. */
  function fakeEditor() {
    const editor = {
      schema,
      isDestroyed: false,
      isEmpty: true,
      content: null as any,
      commands: { setContent: vi.fn((json: any) => void (editor.content = schema.nodeFromJSON(json))) },
    }
    return editor
  }

  const [p1, bad, list, p2] = [id(), id(), id(), id()]
  const loadedDoc: BlockDocV1 = {
    doc_version: 1,
    blocks_order: [p1, bad, list, p2],
    blocks: {
      [p1]: { id: p1, type: "paragraph", version: 1, attrs: { text: "first" } },
      // blockquote requires `block+`; an empty pm blob can't be built into a valid node.
      [bad]: { id: bad, type: "blockquote", version: 1, attrs: { pm: { type: "blockquote", content: [] } } },
      [list]: { id: list, type: "bullet_list", version: 1, attrs: {}, children: [] },
      [p2]: { id: p2, type: "paragraph", version: 1, attrs: { text: "last" } },
    },
  }

  function setup() {
    const { manager, blockDocManager, syncFromEditor } = makeManager()
    const editor = fakeEditor()
    manager.setEditor(editor as any)
    // Mirror what Editor.tsx's sync callback does: editor → BlockDoc maps.
    syncFromEditor.mockImplementation(() => blockDocManager.setBlockDocV1(pmToBlockDoc(editor.content)))
    const onSaveError = vi.fn()
    manager.setCallbacks({ onSaveError })
    api.getPostBlocks.mockResolvedValue({ doc: loadedDoc, revision: 1 })
    return { manager, blockDocManager, editor, onSaveError }
  }

  it("seeds the editor and the maps with the same repaired doc, and reports the drop", async () => {
    const { manager, blockDocManager, editor, onSaveError } = setup()
    await activate(manager)

    expect(editor.content.childCount).toBe(3) // p1, repaired list, p2
    const maps = blockDocManager.getBlockDocV1()
    expect(maps.blocks_order).toEqual([p1, list, p2])
    expect(maps.blocks[bad]).toBeUndefined()
    expect(maps.blocks[list].children).toEqual([synthesizedItemId(list)])
    expect(maps).toEqual(pmToBlockDoc(editor.content))

    expect(onSaveError).toHaveBeenCalledTimes(1)
    expect(onSaveError.mock.calls[0][0].message).toContain(bad)
  })

  it("merges the dropped block back into every autosave at its original position", async () => {
    const { manager, blockDocManager } = setup()
    await activate(manager)

    for (let save = 1; save <= 2; save++) {
      manager.notifyEditorChange()
      await vi.advanceTimersByTimeAsync(1500)
      expect(api.updatePostBlocks).toHaveBeenCalledTimes(save)
      const sent: BlockDocV1 = api.updatePostBlocks.mock.calls[save - 1][1]
      expect(sent.blocks_order).toEqual([p1, bad, list, p2])
      expect(sent.blocks[bad]).toEqual(loadedDoc.blocks[bad])
    }
    // The Yjs maps keep mirroring the editor; only the PUT payload carries the block.
    expect(blockDocManager.getBlockDocV1().blocks[bad]).toBeUndefined()
  })

  it("stops merging them back once a collaborator restores a version (#136)", async () => {
    const { manager, blockDocManager } = setup()
    await activate(manager)

    // A peer's restoreVersion bumps the shared marker (same Y.Doc via sync)
    blockDocManager.markRestored()
    manager.notifyEditorChange()
    await vi.advanceTimersByTimeAsync(1500)

    const sent: BlockDocV1 = api.updatePostBlocks.mock.calls[0][1]
    expect(sent.blocks_order).not.toContain(bad)
    expect(sent.blocks[bad]).toBeUndefined()
  })
})

// #136: restoring a stored version goes through the editor (→ Yjs → peers), then
// saves the working copy with the normal PUT. Never a direct block_doc overwrite.
describe("restoreVersion()", () => {
  const schema = getSchema([StarterKit, BlockIdExtension])

  function setup() {
    const { manager, blockDocManager, syncFromEditor } = makeManager()
    const editor = {
      schema,
      isDestroyed: false,
      isEmpty: true,
      content: null as any,
      commands: {
        setContent: vi.fn((json: any, _opts?: unknown) => void (editor.content = schema.nodeFromJSON(json))),
      },
    }
    manager.setEditor(editor as any)
    syncFromEditor.mockImplementation(() => blockDocManager.setBlockDocV1(pmToBlockDoc(editor.content)))
    const onSaveError = vi.fn()
    manager.setCallbacks({ onSaveError })
    return { manager, blockDocManager, editor, onSaveError }
  }

  const textOf = (doc: BlockDocV1) => doc.blocks_order.map((b) => (doc.blocks[b].attrs as any).text ?? "")

  it("refuses to restore before the document has loaded", async () => {
    const { manager, editor } = setup()
    await expect(manager.restoreVersion(oneBlockDoc("old"))).rejects.toThrow(/loading/)
    expect(editor.commands.setContent).not.toHaveBeenCalled()
    expect(api.updatePostBlocks).not.toHaveBeenCalled()
  })

  it("applies the version through the editor and saves it as the working copy", async () => {
    const { manager, blockDocManager, editor } = setup()
    await activate(manager)
    editor.isEmpty = false
    const setContentCallsAfterLoad = editor.commands.setContent.mock.calls.length

    const version = oneBlockDoc("from version 1")
    const result = await manager.restoreVersion(version)

    expect(result).toEqual({ saved: true })
    expect(editor.commands.setContent).toHaveBeenCalledTimes(setContentCallsAfterLoad + 1)
    // emitUpdate:false like every programmatic load; the ySyncPlugin still syncs it
    expect(editor.commands.setContent.mock.lastCall?.[1]).toEqual({ emitUpdate: false })
    expect(api.updatePostBlocks).toHaveBeenCalledTimes(1)
    const sent: BlockDocV1 = api.updatePostBlocks.mock.calls[0][1]
    expect(textOf(sent)).toEqual(["from version 1"])
    expect(sent.blocks_order).toEqual(version.blocks_order)
    // The Yjs maps now mirror the restored editor content too
    expect(textOf(blockDocManager.getBlockDocV1())).toEqual(["from version 1"])
    expect(manager.hasUnsaved()).toBe(false)
  })

  it("keeps the version's unshowable blocks in the save, not the old ones", async () => {
    const { manager, onSaveError } = setup()
    await activate(manager)
    const [p, bad] = [id(), id()]
    const version: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [p, bad],
      blocks: {
        [p]: { id: p, type: "paragraph", version: 1, attrs: { text: "kept" } },
        [bad]: { id: bad, type: "blockquote", version: 1, attrs: { pm: { type: "blockquote", content: [] } } },
      },
    }

    await manager.restoreVersion(version)

    const sent: BlockDocV1 = api.updatePostBlocks.mock.calls[0][1]
    expect(sent.blocks_order).toEqual([p, bad])
    expect(sent.blocks[bad]).toEqual(version.blocks[bad])
    expect(onSaveError).toHaveBeenCalledTimes(1)
    expect(onSaveError.mock.calls[0][0].message).toContain(bad)
  })

  it("does not save or adopt the version when the editor rejects it", async () => {
    const { manager, editor } = setup()
    await activate(manager)
    editor.commands.setContent.mockImplementationOnce(() => {
      throw new Error("schema mismatch")
    })
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

    await expect(manager.restoreVersion(oneBlockDoc("v1"))).rejects.toThrow(/Failed to load the version/)
    expect(api.updatePostBlocks).not.toHaveBeenCalled()
    expect(manager.hasUnsaved()).toBe(false)
    consoleError.mockRestore()
  })

  it("reports saved:false when a save is in flight, and the follow-up save persists the restore", async () => {
    const { manager } = setup()
    await activate(manager)

    // Hold an autosave open so the restore's forceSave hits the isSaving latch
    let release!: () => void
    api.updatePostBlocks.mockImplementationOnce(
      (_id, doc) => new Promise((resolve) => (release = () => resolve({ doc, revision: 2 })))
    )
    manager.notifyEditorChange()
    await vi.advanceTimersByTimeAsync(1500)
    expect(api.updatePostBlocks).toHaveBeenCalledTimes(1)

    const result = await manager.restoreVersion(oneBlockDoc("restored"))
    expect(result).toEqual({ saved: false })
    expect(manager.hasUnsaved()).toBe(true)

    release()
    await vi.advanceTimersByTimeAsync(1500)
    expect(api.updatePostBlocks).toHaveBeenCalledTimes(2)
    expect(textOf(api.updatePostBlocks.mock.calls[1][1])).toEqual(["restored"])
    expect(manager.hasUnsaved()).toBe(false)
  })
})