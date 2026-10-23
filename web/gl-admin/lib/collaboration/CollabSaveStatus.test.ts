import { describe, it, expect } from "vitest"
import * as Y from "yjs"
import { CollabSaveStatus, type SaveStatusSource } from "./CollabSaveStatus"
import { META_MAP, type StoreMessage } from "./HocuspocusCollaboration"

// CollabSaveStatus against a fake source (#206 P3): a real Y.Doc, a provider stand-in
// whose unsynced count the test drives, and store messages the test sends. The real
// server is in reconnect.hocuspocus.test.ts and liveRestore.test.ts.

function fakeSource() {
  const doc = new Y.Doc()
  const storeListeners = new Set<(m: StoreMessage) => void>()
  const unsyncedListeners = new Set<(e: { number: number }) => void>()
  const provider = {
    hasUnsyncedChanges: false,
    on: (_e: "unsyncedChanges", l: (e: { number: number }) => void) => unsyncedListeners.add(l),
    off: (_e: "unsyncedChanges", l: (e: { number: number }) => void) => unsyncedListeners.delete(l),
  }
  const source: SaveStatusSource = {
    doc,
    provider,
    onStore: (listener) => {
      storeListeners.add(listener)
      return () => storeListeners.delete(listener)
    },
  }
  return {
    source,
    doc,
    provider,
    send: (message: StoreMessage) => [...storeListeners].forEach((l) => l(message)),
    setUnsynced(n: number) {
      provider.hasUnsyncedChanges = n > 0
      ;[...unsyncedListeners].forEach((l) => l({ number: n }))
    },
    localEdit: (text = "x") => doc.getText("t").insert(0, text),
    remoteEdit: (text = "y") =>
      doc.transact(() => doc.getText("t").insert(0, text), provider),
  }
}

const stored = (block_doc: "written" | "kept-invalid" | "kept-empty" | "unchanged" = "written"): StoreMessage => ({
  type: "stored",
  revision: 5,
  block_doc,
})

describe("CollabSaveStatus", () => {
  it("local edit → saving → stored → saved; remote edits don't count", () => {
    const f = fakeSource()
    const status = new CollabSaveStatus(f.source)
    expect(status.getState()).toBe(null)
    f.remoteEdit()
    expect(status.getState()).toBe(null)
    f.localEdit()
    expect(status.getState()).toBe("saving")
    expect(status.hasPendingEdits()).toBe(true)
    f.send(stored())
    expect(status.getState()).toBe("saved")
    expect(status.hasPendingEdits()).toBe(false)
  })

  it("a store that finished while newer edits were still unsent keeps it 'saving'", () => {
    const f = fakeSource()
    const status = new CollabSaveStatus(f.source)
    f.localEdit()
    f.setUnsynced(1)
    f.send(stored())
    expect(status.getState()).toBe("saving")
  })

  it("store_failed and a kept-invalid store are errors", () => {
    const f = fakeSource()
    const status = new CollabSaveStatus(f.source)
    const errors: string[] = []
    status.subscribe(({ state, error }) => state === "error" && errors.push(error!.message))
    f.send({ type: "store_failed" })
    expect(status.getState()).toBe("error")
    f.send(stored("kept-invalid"))
    expect(errors).toHaveLength(2)
    expect(errors[1]).toMatch(/valid content/)
    f.send(stored("kept-empty"))
    expect(status.getState()).toBe("saved")
  })

  it("waitForStored waits for the server to have every edit, then for the next store", async () => {
    const f = fakeSource()
    const status = new CollabSaveStatus(f.source)
    f.localEdit()
    f.setUnsynced(1)
    const waiting = status.waitForStored({ timeoutMs: 1000 })
    let done = false
    void waiting.then(() => (done = true))
    // A store that finishes before the server acknowledged our edit doesn't count.
    f.send(stored())
    await Promise.resolve()
    expect(done).toBe(false)
    f.setUnsynced(0)
    await Promise.resolve()
    f.send(stored())
    await expect(waiting).resolves.toMatchObject({ type: "stored", revision: 5 })
  })

  it("waitForStored rejects on store_failed, kept-invalid, and timeout", async () => {
    const f = fakeSource()
    const status = new CollabSaveStatus(f.source)
    const failed = status.waitForStored()
    await Promise.resolve()
    f.send({ type: "store_failed" })
    await expect(failed).rejects.toMatchObject({ kind: "failed" })
    const invalid = status.waitForStored()
    await Promise.resolve()
    f.send(stored("kept-invalid"))
    await expect(invalid).rejects.toMatchObject({ kind: "invalid" })
    await expect(status.waitForStored({ timeoutMs: 10 })).rejects.toMatchObject({ kind: "timeout" })
  })

  it("settled() returns at once with nothing pending", async () => {
    const f = fakeSource()
    const status = new CollabSaveStatus(f.source)
    await status.settled({ timeoutMs: 1 })
  })

  it("reads and watches meta.dropped", () => {
    const f = fakeSource()
    const status = new CollabSaveStatus(f.source)
    const seen: number[] = []
    const off = status.watchDroppedBlocks((entries) => seen.push(entries.length))
    f.doc.getMap(META_MAP).set("dropped", { entries: [{ id: "a", parentId: null, afterId: null }], blocks: {} })
    f.doc.getMap(META_MAP).set("epoch", "e")
    f.doc.getMap(META_MAP).delete("dropped")
    off()
    expect(seen).toEqual([0, 1, 0])
  })

  it("stops listening when destroyed", () => {
    const f = fakeSource()
    const status = new CollabSaveStatus(f.source)
    status.destroy()
    f.localEdit()
    expect(status.getState()).toBe(null)
  })
})
