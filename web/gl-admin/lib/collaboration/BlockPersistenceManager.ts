import { blockAPIClient, ConflictError, UnauthorizedError } from "../api/blockAPI"
import type { BlockDocV1 } from "../blocks-spec"
import type { BlockDocManager } from "./BlockDocManager"
import type { Editor } from "@tiptap/react"
import { blockDocToPM } from "./blockBridge"
import { collabDebug } from "./debug"

/**
 * Manages debounced persistence of block documents to the API
 * Handles optimistic concurrency and conflict resolution
 */
export class BlockPersistenceManager {
  private postId: number
  private blockDocManager: BlockDocManager
  private editor: Editor | null
  private syncFromEditor: (() => void) | null = null
  private title?: string
  private saveTimer: NodeJS.Timeout | null = null
  private currentRevision: number = 1
  private isSaving: boolean = false
  private isInitializing: boolean = true
  private hasUnsavedChanges: boolean = false
  private suspended: boolean = false
  private suspendReason: "unauthorized" | null = null
  // Guard: the initial API load + setContent must happen exactly once. A second
  // call (e.g. from a reconnect re-firing "synced") would overwrite unsaved edits.
  private hasInitialized: boolean = false
  // Monotonic counter incremented on every notifyEditorChange. performSave snapshots
  // this counter before mirroring; if the counter has advanced by the time the API
  // call resolves, edits arrived DURING the save (their content is NOT in the doc
  // we just persisted), so we must NOT clear hasUnsavedChanges and may need to
  // re-schedule a follow-up save. Without this, in-flight edits are silently lost.
  private editChangeSeq: number = 0

  // Configuration
  private readonly SAVE_DEBOUNCE_MS = 1500 // 1.5 seconds idle time
  private readonly MAX_RETRY_ATTEMPTS = 3

  // Status callbacks
  private onSaveStart?: () => void
  private onSaveSuccess?: (revision: number) => void
  private onSaveError?: (error: Error) => void
  private onConflictResolved?: (latestDoc: BlockDocV1) => void

  constructor(postId: number, blockDocManager: BlockDocManager, authToken?: string, title?: string) {
    this.postId = postId
    this.blockDocManager = blockDocManager
    this.editor = null // Will be set via setEditor() after editor is created
    this.title = title

    if (authToken) {
      blockAPIClient.setAuthToken(authToken)
    }

    // NOTE: we intentionally do NOT subscribe to blockDocManager.onDocumentChange
    // for autosave. Autosave is driven solely by editor edits via notifyEditorChange().
    //
    // Observing the BlockDoc maps caused a self-sustaining save loop after a WS
    // restart (the "heartbeat"): performSave mirrors the editor into the maps via
    // setBlockDocV1; that write syncs to the WS server, the server echoes it back on
    // the next 2s resync, and the echo re-triggered another save → echo → ... forever,
    // with the revision climbing every 2s. (setBlockDocV1 is now incremental and a
    // no-op for unchanged content — see BlockDocManager — which further dampens this,
    // but removing this map-observer trigger is what actually breaks the loop.)
    // Editor updates already cover both local edits and remote collaborator edits
    // (the collaboration plugin applies remote changes as editor transactions, which
    // fire `update`), so map observation is redundant.
  }

  /**
   * Set status callback handlers
   */
  setCallbacks(callbacks: {
    onSaveStart?: () => void
    onSaveSuccess?: (revision: number) => void
    onSaveError?: (error: Error) => void
    onConflictResolved?: (latestDoc: BlockDocV1) => void
  }) {
    this.onSaveStart = callbacks.onSaveStart
    this.onSaveSuccess = callbacks.onSaveSuccess
    this.onSaveError = callbacks.onSaveError
    this.onConflictResolved = callbacks.onConflictResolved
  }

  /**
   * Set the editor instance (called after editor is created)
   */
  setEditor(editor: Editor) {
    this.editor = editor
  }

  /**
   * Set callback to sync editor state to BlockDoc before save/publish
   */
  setSyncCallback(callback: () => void) {
    this.syncFromEditor = callback
  }

  /**
   * Check if currently initializing (used to prevent premature mirroring/autosave)
   */
  isCurrentlyInitializing(): boolean {
    return this.isInitializing
  }

  /**
   * Allow editor to update auth token at runtime
   */
  setAuthToken(token: string | null) {
    if (token) {
      blockAPIClient.setAuthToken(token)
      if (this.suspended && this.suspendReason === "unauthorized") {
        this.resume() // try to recover immediately on next change
      }
    }
  }

  /**
   * Update the title to be saved with next block save
   */
  setTitle(title: string) {
    this.title = title
  }

  /**
   * Load initial document state from API
   */
  async initialize(): Promise<void> {
    // Idempotent on success: once a load has succeeded, subsequent calls return
    // early (reconnects, effect re-runs must not re-seed the editor or they
    // clobber unsaved typing). On failure we deliberately do NOT mark initialized
    // so that a retry — e.g. after the token refreshes — can succeed.
    if (this.hasInitialized) return

    // Track success separately so we can both (a) decide whether to keep the
    // hasInitialized guard set in the finally and (b) avoid leaving the manager
    // stuck in isInitializing=true (which would permanently disable autosave).
    let loadedOk = false

    try {
      const { doc, revision } = await blockAPIClient.getPostBlocks(this.postId)
      this.currentRevision = revision

      // Seed from the REST working copy ONLY when the live Yjs doc is empty (a cold
      // start: no IndexedDB cache and an empty WS/LevelDB doc). When the collaborative
      // doc has already been restored with content (a warm reload — IndexedDB + the WS
      // server repopulate it, and the Collaboration plugin shows it), Yjs is the source
      // of truth. Overwriting it here is the bug behind the reload "heartbeat":
      // setContent(blockDocToPM(doc)) becomes delete-all + insert-new on the
      // already-populated prosemirror fragment via ySyncPlugin, creating a competing
      // parallel state that the 2s resync then fights, reverting the user's content.
      // So we seed only the side(s) that are actually empty.
      if (doc.blocks_order.length > 0 || Object.keys(doc.blocks).length > 0) {
        const current = this.blockDocManager.getBlockDocV1()
        const blocksAlreadyPopulated =
          current.blocks_order.length > 0 || Object.keys(current.blocks).length > 0
        const editorAlreadyPopulated = !!this.editor && !this.editor.isDestroyed && !this.editor.isEmpty

        if (!blocksAlreadyPopulated) {
          this.blockDocManager.setBlockDocV1(doc)
        }

        if (this.editor && !this.editor.isDestroyed && !editorAlreadyPopulated) {
          // emitUpdate:false suppresses TipTap's "update" event for this programmatic
          // seed. The content still syncs into the Yjs "prosemirror" fragment because
          // the collaboration ySyncPlugin mirrors the transaction regardless of the flag.
          try {
            const pmDoc = blockDocToPM(doc, this.editor.schema)
            this.editor.commands.setContent(pmDoc.toJSON(), { emitUpdate: false })
          } catch (error) {
            console.error("Failed to convert/apply blocks to editor:", error)
          }
        }
      }
      // Empty block_doc is fine - editor will start with empty state

      loadedOk = true
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        this.suspended = true
        this.suspendReason = "unauthorized"
        this.onSaveError?.(error)
      } else {
        console.error("Failed to load initial document:", error)
        this.onSaveError?.(error as Error)
      }
      // Leave hasInitialized=false so a later retry (e.g. after token refresh)
      // can complete the load. Fall through to the finally to release the
      // isInitializing latch — otherwise autosave stays permanently disabled.
    } finally {
      collabDebug("initialize done", { loadedOk, revision: this.currentRevision })
      // Only mark "initialized" if the load actually succeeded; this is what
      // prevents reconnect-driven re-seeds from clobbering unsaved typing.
      if (loadedOk) this.hasInitialized = true

      // Always release the init latch so autosave can run on the next edit,
      // even when the initial load failed. The 500ms delay matches the original
      // behaviour: give the editor + Y.js a beat to stabilise before we permit
      // change handlers to schedule saves.
      setTimeout(() => {
        this.isInitializing = false
      }, 500)
    }
  }

  /**
   * Notify that the editor content changed (called on every editor `update`).
   *
   * This is the PRIMARY autosave trigger. There is intentionally no per-keystroke
   * editor → BlockDoc mirror (that would flood Yjs/WebSocket with full-document
   * replacements); instead we just schedule the debounced save here and mirror the
   * editor into the BlockDoc once, inside performSave, right before persisting.
   */
  notifyEditorChange(): void {
    if (this.isInitializing) return
    if (this.suspended) return

    // Always record the edit and schedule a debounced save, EVEN while a save is
    // in-flight. The previous `if (isSaving) return` early-out caused edits typed
    // during the network round-trip to be silently dropped: their content was not
    // yet mirrored into the BlockDoc (mirror runs once at the start of performSave),
    // no new timer was scheduled, and the in-flight save's success path would then
    // clear hasUnsavedChanges — losing the edit. The editChangeSeq counter +
    // re-schedule logic in performSave handles the race correctly.
    this.editChangeSeq++
    this.hasUnsavedChanges = true
    this.debouncedSave()
  }

  /**
   * Debounced save - resets timer on each call
   */
  private debouncedSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
    }

    this.saveTimer = setTimeout(() => {
      // Null the ref now that the timer has fired, so `this.saveTimer` always
      // reflects "a debounce is pending". performSave's missed-timer recovery
      // relies on `!this.saveTimer`; without this, a fired-but-not-cleared timer
      // looks pending forever and a follow-up save is never rescheduled — silently
      // dropping edits that landed during an in-flight save.
      this.saveTimer = null
      this.performSave()
    }, this.SAVE_DEBOUNCE_MS)
  }

  /**
   * Perform the actual save operation
   */
  private async performSave(retryCount = 0, isExplicit = false): Promise<void> {
    if (!this.hasUnsavedChanges || this.isSaving || this.suspended) return

    collabDebug("performSave start", {
      retryCount,
      isExplicit,
      revision: this.currentRevision,
      hasUnsavedChanges: this.hasUnsavedChanges,
    })

    // Mark the save in progress. This latch makes performSave non-re-entrant: a
    // debounce timer that fires while a save is in flight hits the guard above and
    // is absorbed; the finally block reschedules if edits are still pending.
    this.isSaving = true

    // Snapshot the edit counter BEFORE mirroring. Any edits that arrive AFTER
    // this point won't be in the doc we're about to persist; we detect that
    // by comparing this snapshot to editChangeSeq after the API call returns.
    const seqAtSaveStart = this.editChangeSeq

    // Everything from the editor mirror through the API call lives inside the
    // try/finally so that any synchronous throw (e.g. pmToBlockDoc on a malformed
    // node, or an exception thrown by the consumer's syncFromEditor callback)
    // still releases the isSaving latch in finally. Without this guard, a single
    // bad keystroke could leave isSaving=true and disable autosave for the
    // entire session.
    try {
      // Mirror the live editor into the BlockDoc right before persisting, so the
      // working copy reflects what the user actually typed. Done once per save
      // here (not per keystroke) to avoid Yjs/WebSocket write amplification.
      try {
        this.syncFromEditor?.()
      } catch (error) {
        console.error("Failed to sync editor → BlockDoc before save:", error)
        this.onSaveError?.(error as Error)
        return // skip this save; isSaving is cleared by the outer finally
      }

      const currentDoc = this.blockDocManager.getBlockDocV1()

      // Safety guard: never let an AUTOSAVE overwrite the working copy with an
      // empty document. A valid doc always has >= 1 top-level block (ProseMirror
      // guarantees at least one paragraph), so 0 blocks means an uninitialized
      // /empty mirror — persisting that is exactly what previously wiped saved
      // content. Explicit saves (force/publish) may still write empty intentionally.
      if (currentDoc.blocks_order.length === 0 && !isExplicit) {
        console.warn("[autosave] skipping empty document — would overwrite working copy")
        collabDebug("performSave SKIP empty doc")
        return // outer finally clears isSaving
      }

      this.onSaveStart?.()

      try {
        const { doc, revision } = await blockAPIClient.updatePostBlocks(
          this.postId,
          currentDoc,
          this.currentRevision,
          this.title
        )

        // Success
        this.currentRevision = revision
        // Only clear hasUnsavedChanges if no new edits came in while the API
        // call was in flight. If editChangeSeq advanced, those edits are NOT
        // in the doc we just persisted — keep the flag set so the follow-up
        // debounce (scheduled by notifyEditorChange, or re-scheduled in finally
        // below if it fired into the isSaving guard) will pick them up.
        if (this.editChangeSeq === seqAtSaveStart) {
          this.hasUnsavedChanges = false
        }
        this.onSaveSuccess?.(revision)
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          // Suspend until token is present; surface error once.
          this.suspended = true
          this.suspendReason = "unauthorized"
          this.onSaveError?.(error)
          return // stop retry loop; outer finally clears isSaving
        }

        if (error instanceof ConflictError && retryCount < this.MAX_RETRY_ATTEMPTS) {
          await this.resolveConflict()

          // Retry save after conflict resolution (preserve explicit-save intent)
          setTimeout(() => {
            this.performSave(retryCount + 1, isExplicit)
          }, 500)
          return
        }

        console.error("Save failed:", error)
        this.onSaveError?.(error as Error)
      }
    } finally {
      this.isSaving = false

      // Recover from a "missed timer" race: while isSaving was true, the
      // debounce timer that was set by notifyEditorChange may have already
      // fired into performSave's `isSaving` guard and returned early — the
      // timer is now consumed (saveTimer is null) but hasUnsavedChanges is
      // still true. If we don't re-schedule here, those edits sit forever.
      // Skip if suspended (resume() will handle it) or if a save was just
      // queued via the ConflictError retry path (its setTimeout is independent
      // and shouldn't be doubled-up).
      if (this.hasUnsavedChanges && !this.saveTimer && !this.suspended) {
        this.debouncedSave()
      }
    }
  }

  /**
   * Resolve conflicts by fetching latest and applying last-write-wins
   */
  private async resolveConflict(): Promise<void> {
    try {
      const { doc: latestDoc, revision } = await blockAPIClient.getPostBlocks(this.postId)

      // Update local state with server version (last-write-wins for Phase A)
      this.blockDocManager.setBlockDocV1(latestDoc)
      this.currentRevision = revision
      this.hasUnsavedChanges = false

      this.onConflictResolved?.(latestDoc)
    } catch (error) {
      console.error("Failed to resolve conflict:", error)
      throw error
    }
  }

  /**
   * Force immediate save (bypass debounce)
   */
  async forceSave(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }

    // Explicit save: allowed to persist an empty document if the user truly cleared it.
    await this.performSave(0, true)
  }

  /**
   * Publish current working copy
   */
  async publish(label?: string, message?: string): Promise<{ versionId: number; versionNo: number }> {
    // Sync editor state to BlockDoc first (includes unsaved changes)
    if (this.syncFromEditor) {
      this.syncFromEditor()
    }

    // Force save first to ensure latest changes are persisted
    await this.forceSave()

    try {
      const result = await blockAPIClient.publishPost(this.postId, label, message)
      return result
    } catch (error) {
      console.error("Publish failed:", error)
      throw error
    }
  }

  /**
   * Get current revision number
   */
  getCurrentRevision(): number {
    return this.currentRevision
  }

  /**
   * Check if there are unsaved changes
   */
  hasUnsaved(): boolean {
    return this.hasUnsavedChanges
  }

  /**
   * Resume after fixing auth (e.g., user logged in)
   */
  resume() {
    this.suspended = false
    this.suspendReason = null
    if (this.hasUnsavedChanges) {
      this.debouncedSave()
    }
  }

  /**
   * Cleanup timers and subscriptions
   */
  destroy(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
  }
}
