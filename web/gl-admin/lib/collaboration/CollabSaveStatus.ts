import type * as Y from "yjs"
import type { DroppedBlocks } from "./fragmentBridge"
import { META_MAP, type StoreMessage } from "./HocuspocusCollaboration"

// Save status for the Hocuspocus path (#206 P3, #283). It replaces
// BlockPersistenceManager there: the client saves nothing. The collab server stores the
// doc (debounced) and broadcasts the result to every client:
//   - a local edit                  → "saving" (not stored yet);
//   - `stored`                      → "saved", unless block_doc was "kept-invalid": the
//                                     Yjs state is safe but the working copy publish
//                                     reads wasn't updated, so it's an error;
//   - `store_failed`                → "error" (the server keeps the doc and retries).
// Remote edits don't flip it to "saving": they're the other client's save.
//
// It also reads the blocks the server's seed couldn't put in the editor (#213), from
// `meta.dropped`, for the "N blocks can't be shown" notice.

export type SaveState = "saved" | "saving" | "error" | null

/** What CollabSaveStatus needs from HocuspocusCollaboration (a fake in tests). */
export interface SaveStatusSource {
  doc: Y.Doc
  /** The transaction origin remote updates are applied with. */
  provider: {
    hasUnsyncedChanges: boolean
    on(event: "unsyncedChanges", listener: (e: { number: number }) => void): unknown
    off(event: "unsyncedChanges", listener: (e: { number: number }) => void): unknown
  }
  onStore(listener: (message: StoreMessage) => void): () => void
}

export type CollabStoreErrorKind = "timeout" | "failed" | "invalid"

export class CollabStoreError extends Error {
  constructor(
    message: string,
    readonly kind: CollabStoreErrorKind
  ) {
    super(message)
    this.name = "CollabStoreError"
  }
}

export interface SaveStatusChange {
  state: SaveState
  /** Why it's "error", for the UI. */
  error?: Error
  /** The block_revision the server reported with "saved", when it has one. */
  revision?: number
}

export class CollabSaveStatus {
  private state: SaveState = null
  /** A local edit the server hasn't reported stored yet. */
  private pending = false
  private readonly listeners = new Set<(change: SaveStatusChange) => void>()
  private readonly offStore: () => void
  private readonly onUpdate: (update: Uint8Array, origin: unknown) => void

  constructor(private readonly source: SaveStatusSource) {
    this.onUpdate = (_update, origin) => {
      if (origin === source.provider) return
      this.pending = true
      this.set({ state: "saving" })
    }
    source.doc.on("update", this.onUpdate)
    this.offStore = source.onStore((message) => this.handleStore(message))
  }

  getState(): SaveState {
    return this.state
  }

  hasPendingEdits(): boolean {
    return this.pending
  }

  subscribe(listener: (change: SaveStatusChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Resolves with the next `stored` message for a store that includes every local edit
   * made so far: it first waits until the server has acknowledged them (the provider has
   * no unsynced changes), so a store that started after that has them. Rejects on
   * `store_failed`, a `kept-invalid` store, or after `timeoutMs`.
   */
  async waitForStored({ timeoutMs = 15_000 } = {}): Promise<Extract<StoreMessage, { type: "stored" }>> {
    const deadline = Date.now() + timeoutMs
    await this.whenAcknowledged(timeoutMs)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new CollabStoreError("The collaboration server hasn't confirmed the save yet", "timeout"))
      }, Math.max(0, deadline - Date.now()))
      const off = this.source.onStore((message) => {
        clearTimeout(timer)
        off()
        if (message.type === "store_failed") reject(new CollabStoreError("The collaboration server couldn't save; it keeps retrying", "failed"))
        else if (message.block_doc === "kept-invalid") reject(new CollabStoreError(INVALID_MESSAGE, "invalid"))
        else resolve(message)
      })
    })
  }

  /** Nothing local pending → now; else the next store (see waitForStored). */
  async settled(options?: { timeoutMs?: number }): Promise<void> {
    if (!this.pending) return
    await this.waitForStored(options)
  }

  /** The blocks the server's seed couldn't show in the editor (kept in block_doc). */
  droppedBlocks(): DroppedBlocks["entries"] {
    const dropped = this.source.doc.getMap(META_MAP).get("dropped") as DroppedBlocks | undefined
    return dropped && Array.isArray(dropped.entries) ? dropped.entries : []
  }

  /** Calls `listener` with the dropped entries now and whenever `meta.dropped` changes. */
  watchDroppedBlocks(listener: (entries: DroppedBlocks["entries"]) => void): () => void {
    const meta = this.source.doc.getMap(META_MAP)
    const observer = (event: Y.YMapEvent<unknown>) => {
      if (event.keysChanged.has("dropped")) listener(this.droppedBlocks())
    }
    meta.observe(observer)
    listener(this.droppedBlocks())
    return () => meta.unobserve(observer)
  }

  destroy(): void {
    this.source.doc.off("update", this.onUpdate)
    this.offStore()
    this.listeners.clear()
  }

  private handleStore(message: StoreMessage) {
    if (message.type === "store_failed") {
      this.set({ state: "error", error: new CollabStoreError("Saving failed; the server keeps retrying", "failed") })
    } else if (message.block_doc === "kept-invalid") {
      this.set({ state: "error", error: new CollabStoreError(INVALID_MESSAGE, "invalid") })
    } else {
      // Nothing of ours was waiting: another user's edit was stored. Not our save.
      if (!this.pending && this.state !== "error") return
      // Edits typed after this store began keep their own debounced store coming.
      if (!this.source.provider.hasUnsyncedChanges) this.pending = false
      this.set({ state: this.pending ? "saving" : "saved", revision: message.revision ?? undefined })
    }
  }

  /** Resolves once the server has received every local edit (the provider has none unsynced). */
  whenAcknowledged(timeoutMs = 15_000): Promise<void> {
    const { provider } = this.source
    if (!provider.hasUnsyncedChanges) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        provider.off("unsyncedChanges", onChange)
        reject(new CollabStoreError("The collaboration server hasn't received the change yet", "timeout"))
      }, timeoutMs)
      const onChange = () => {
        if (provider.hasUnsyncedChanges) return
        clearTimeout(timer)
        provider.off("unsyncedChanges", onChange)
        resolve()
      }
      provider.on("unsyncedChanges", onChange)
    })
  }

  private set(change: SaveStatusChange) {
    // Every keystroke is an update: tell listeners about transitions only (errors always).
    if (change.state === this.state && change.state !== "error") return
    this.state = change.state
    for (const listener of [...this.listeners]) listener(change)
  }
}

const INVALID_MESSAGE =
  "The document couldn't be saved as valid content; your edits are kept in the live document, but the saved draft wasn't updated"
