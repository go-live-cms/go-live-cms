import { blockAPIClient, ConflictError, UnauthorizedError } from "../api/blockAPI"
import type { BlockDocV1 } from "../blocks-spec"
import type { BlockDocManager } from "./BlockDocManager"
import type { Editor } from "@tiptap/react"
import { blockDocToPM } from "./blockBridge"

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
  private unsubscribeDocChange?: () => void
  private suppressNextChange: boolean = false
  // Guard: the initial API load + setContent must happen exactly once. A second
  // call (e.g. from a reconnect re-firing "synced") would overwrite unsaved edits.
  private hasInitialized: boolean = false

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

    // Subscribe to block document changes and save cleanup function
    this.unsubscribeDocChange = this.blockDocManager.onDocumentChange(this.handleDocumentChange.bind(this))
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
    // Idempotent: only the first call loads content. Subsequent calls (reconnects,
    // effect re-runs) must not re-seed the editor or they clobber unsaved typing.
    if (this.hasInitialized) return
    this.hasInitialized = true

    try {
      const { doc, revision } = await blockAPIClient.getPostBlocks(this.postId)
      this.currentRevision = revision

      // Only set if the document is not empty (has actual content)
      if (doc.blocks_order.length > 0 || Object.keys(doc.blocks).length > 0) {
        // Update Y.js BlockDoc
        this.blockDocManager.setBlockDocV1(doc)

        // If we have an editor, convert and apply to editor state.
        // emitUpdate:false suppresses TipTap's "update" event for this programmatic
        // load (so it doesn't look like a user edit / trigger autosave). The content
        // still syncs into the Yjs "prosemirror" fragment because the collaboration
        // ySyncPlugin mirrors the transaction regardless of the emitUpdate flag.
        if (this.editor && !this.editor.isDestroyed) {
          try {
            const pmDoc = blockDocToPM(doc, this.editor.schema)
            this.editor.commands.setContent(pmDoc.toJSON(), { emitUpdate: false })
          } catch (error) {
            console.error("Failed to convert/apply blocks to editor:", error)
          }
        }
      }
      // Empty block_doc is fine - editor will start with empty state

      // Wait for editor and Y.js to fully stabilize before enabling autosave
      setTimeout(() => {
        this.isInitializing = false
      }, 500)
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        this.suspended = true
        this.suspendReason = "unauthorized"
        this.onSaveError?.(error)
        return
      }
      console.error("Failed to load initial document:", error)
      this.onSaveError?.(error as Error)
    }
  }

  /**
   * Handle document changes from the block manager
   */
  private handleDocumentChange(doc: BlockDocV1): void {
    if (this.isInitializing) return // Ignore ALL changes during initial load
    if (this.isSaving) return // Don't trigger saves during API updates
    if (this.suspended) return // Don't queue saves while suspended
    if (this.suppressNextChange) {
      this.suppressNextChange = false
      return
    }

    this.hasUnsavedChanges = true
    this.debouncedSave()
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
    if (this.isSaving) return
    if (this.suspended) return

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
      this.performSave()
    }, this.SAVE_DEBOUNCE_MS)
  }

  /**
   * Perform the actual save operation
   */
  private async performSave(retryCount = 0, isExplicit = false): Promise<void> {
    if (!this.hasUnsavedChanges || this.isSaving || this.suspended) return

    // Set isSaving FIRST so the mirror below (which writes the BlockDoc maps) does
    // not re-trigger handleDocumentChange → another save.
    this.isSaving = true

    // Mirror the live editor into the BlockDoc right before persisting, so the
    // working copy reflects what the user actually typed. Done once per save here
    // (not per keystroke) to avoid Yjs/WebSocket write amplification.
    this.syncFromEditor?.()

    const currentDoc = this.blockDocManager.getBlockDocV1()

    // Safety guard: never let an AUTOSAVE overwrite the working copy with an empty
    // document. A valid doc always has >= 1 top-level block (ProseMirror guarantees
    // at least one paragraph), so 0 blocks means an uninitialized/empty mirror —
    // persisting that is exactly what previously wiped saved content. Explicit
    // saves (force/publish) may still write empty intentionally.
    if (currentDoc.blocks_order.length === 0 && !isExplicit) {
      console.warn("[autosave] skipping empty document — would overwrite working copy")
      this.isSaving = false
      return
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
      this.hasUnsavedChanges = false
      this.onSaveSuccess?.(revision)
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        // Suspend until token is present; surface error once.
        this.suspended = true
        this.suspendReason = "unauthorized"
        this.onSaveError?.(error)
        return // stop retry loop
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
    } finally {
      this.isSaving = false
    }
  }

  /**
   * Resolve conflicts by fetching latest and applying last-write-wins
   */
  private async resolveConflict(): Promise<void> {
    try {
      const { doc: latestDoc, revision } = await blockAPIClient.getPostBlocks(this.postId)

      // Update local state with server version (last-write-wins for Phase A)
      this.suppressNextChange = true
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
    // IMPORTANT: unsubscribe so old instances don't keep saving
    if (this.unsubscribeDocChange) {
      this.unsubscribeDocChange()
      this.unsubscribeDocChange = undefined
    }
  }
}
