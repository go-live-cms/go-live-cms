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
  setEditor(editor: Editor | null) {
    this.editor = editor
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
    try {
      console.log(`🔄 Loading blocks for post ${this.postId}...`)
      const { doc, revision } = await blockAPIClient.getPostBlocks(this.postId)
      this.currentRevision = revision

      console.log(`📥 Received blocks for post ${this.postId}:`, {
        revision,
        blocksCount: Object.keys(doc.blocks).length,
        blocksOrder: doc.blocks_order.length,
        isEmpty: doc.blocks_order.length === 0 && Object.keys(doc.blocks).length === 0,
        doc,
      })

      // Only set if the document is not empty (has actual content)
      if (doc.blocks_order.length > 0 || Object.keys(doc.blocks).length > 0) {
        console.log(`✅ Loading blocks into Y.js for post ${this.postId}`)

        // Update Y.js BlockDoc
        this.blockDocManager.setBlockDocV1(doc)

        // If we have an editor, convert and apply to editor state
        // Use emitUpdate: false to prevent triggering autosave during initialization
        if (this.editor && !this.editor.isDestroyed) {
          try {
            const pmDoc = blockDocToPM(doc, this.editor.schema)
            console.log(`🔄 Applying loaded blocks to editor (${doc.blocks_order.length} blocks)...`)

            // Replace entire document content WITHOUT emitting update
            this.editor.commands.setContent(pmDoc.toJSON(), { emitUpdate: false })

            console.log(`✅ Editor content updated from loaded blocks`)
          } catch (error) {
            console.error(`❌ Failed to convert/apply blocks to editor:`, error)
          }
        }

        console.log(`✅ Initial blocks loaded for post ${this.postId}`)
      } else {
        console.warn(`⚠️ Post ${this.postId} has empty block_doc, editor will start with empty state`)
      }

      // Wait longer for editor and Y.js to fully stabilize before enabling autosave
      // This prevents race conditions where partially-loaded content gets saved
      setTimeout(() => {
        this.isInitializing = false
        console.log(`✅ Autosave enabled for post ${this.postId}`)
      }, 500) // Increased to 500ms to ensure full stabilization
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        this.suspended = true
        this.suspendReason = "unauthorized"
        this.onSaveError?.(error)
        return
      }
      console.error(`❌ Failed to load initial document for post ${this.postId}:`, error)
      this.onSaveError?.(error as Error)
    }
  }

  /**
   * Handle document changes from the block manager
   */
  private handleDocumentChange(doc: BlockDocV1): void {
    console.log(`📝 handleDocumentChange called for post ${this.postId}:`, {
      isSaving: this.isSaving,
      isInitializing: this.isInitializing,
      suspended: this.suspended,
      suppressNextChange: this.suppressNextChange,
      blocksCount: Object.keys(doc.blocks).length,
    })

    if (this.isInitializing) {
      console.log(`🚫 Ignoring change during initialization for post ${this.postId}`)
      return // Ignore ALL changes during initial load
    }
    if (this.isSaving) return // Don't trigger saves during API updates
    if (this.suspended) return // Don't queue saves while suspended
    if (this.suppressNextChange) {
      console.log(`🚫 Suppressing change event for post ${this.postId}`)
      this.suppressNextChange = false
      return
    }

    console.log(`💾 Change detected for post ${this.postId}, queuing save...`)
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
  private async performSave(retryCount = 0): Promise<void> {
    if (!this.hasUnsavedChanges || this.isSaving || this.suspended) return

    this.isSaving = true
    this.onSaveStart?.()

    try {
      const currentDoc = this.blockDocManager.getBlockDocV1()

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

      console.log(`💾 Saved post ${this.postId} blocks, revision ${revision}`)
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        // Suspend until token is present; surface error once.
        this.suspended = true
        this.suspendReason = "unauthorized"
        this.onSaveError?.(error)
        return // stop retry loop
      }

      if (error instanceof ConflictError && retryCount < this.MAX_RETRY_ATTEMPTS) {
        console.warn(`🔄 Conflict detected, attempting to resolve (attempt ${retryCount + 1})`)
        await this.resolveConflict()

        // Retry save after conflict resolution
        setTimeout(() => {
          this.performSave(retryCount + 1)
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
      console.log(`🔄 Conflict resolved with server version, revision ${revision}`)
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

    await this.performSave()
  }

  /**
   * Publish current working copy
   */
  async publish(label?: string, message?: string): Promise<{ versionId: number; versionNo: number }> {
    // Log current BlockDoc state before saving
    const currentDoc = this.blockDocManager.getBlockDocV1()
    console.log(`📋 About to publish - Current BlockDoc state:`, {
      blocksCount: Object.keys(currentDoc.blocks).length,
      blocksOrder: currentDoc.blocks_order,
      blocks: Object.entries(currentDoc.blocks).map(([id, block]) => ({
        id,
        type: block.type,
        text: (block.attrs as any).text || "(no text)",
      })),
    })

    // Force save first to ensure latest changes are persisted
    await this.forceSave()

    try {
      const result = await blockAPIClient.publishPost(this.postId, label, message)
      console.log(`📡 Published post ${this.postId} as version ${result.versionNo}`)
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
