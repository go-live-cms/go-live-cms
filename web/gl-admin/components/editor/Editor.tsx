import { useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle, useCallback } from "react"
import { EditorContent, useEditor } from "@tiptap/react"
import { CollaborationProvider } from "@gl-admin/lib/collaboration/CollaborationProvider"
import { BlockDocManager } from "@gl-admin/lib/collaboration/BlockDocManager"
import { BlockPersistenceManager } from "@gl-admin/lib/collaboration/BlockPersistenceManager"
import { pmToBlockDoc } from "@gl-admin/lib/collaboration/blockBridge"
import { createTestScript } from "@gl-admin/lib/test/blockSpecTest"
import { authManager } from "@gl-admin/lib/auth"
import { applyLink, openLinkModal } from "./utils/linkManager"
import { useTheme } from "@gl-admin/contexts/ThemeContext"
import LinkModal from "./ui/LinkModal"
import BubbleMenu from "./ui/BubbleMenu"
import BlockTypeToolbar from "./ui/BlockTypeToolbar"
import DragHandle from "./ui/DragHandle"
import CharacterCount from "./ui/CharacterCount"
import MediaSelector from "./ui/MediaSelector"
import { getExtensions } from "./utils/extensions"
import "@gl-admin/assets/styles/components/editor/editor.scss"

type Props = {
  value: string
  onChange: (html: string, plainText: string) => void
  placeholder?: string
  readOnly?: boolean
  minChars?: number
  maxChars?: number
  postId?: number
  title?: string
  enableCollaboration?: boolean
  // Block Spec v1 persistence callbacks
  onSaveStart?: () => void
  onSaveSuccess?: (revision: number) => void
  onSaveError?: (error: Error) => void
  onPublishStart?: () => void
  onPublishSuccess?: (result: { versionId: number; versionNo: number }) => void
  onPublishError?: (error: Error) => void
}

export interface EditorRef {
  forceSave: () => Promise<void>
  publish: () => Promise<{ versionId: number; versionNo: number } | undefined>
  getSaveStatus: () => { isSaving: boolean; isPublishing: boolean; saveStatus: "saved" | "saving" | "error" | null }
}

const EditorInner = forwardRef<EditorRef, Props>(function EditorInner(
  {
    value,
    onChange,
    placeholder = "Type '/' for commands...",
    readOnly = false,
    minChars,
    maxChars,
    postId,
    title,
    enableCollaboration = true,
    onSaveStart,
    onSaveSuccess,
    onSaveError,
    onPublishStart,
    onPublishSuccess,
    onPublishError,
  },
  ref
) {
  const { isThemeLoaded } = useTheme()
  const [isSaving, setIsSaving] = useState(false)
  const [isPublishing, setIsPublishing] = useState(false)
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "error" | null>(null)
  const persistenceRef = useRef<BlockPersistenceManager | null>(null)
  // Tracks the postId that persistenceRef.current was created for, so we can
  // detect navigation between posts (/content/edit/1 → /content/edit/2) where
  // React Router reuses the same Editor instance with a new postId prop. Without
  // this, the manager bound to the OLD postId would keep saving the user's edits
  // to the previous post — a data-corruption bug.
  const persistencePostIdRef = useRef<number | null>(null)
  const titleRef = useRef<string | undefined>(title)
  // Guard: the initial-content load (setContent from API) must run EXACTLY ONCE.
  // The provider's "synced" event re-fires on every reconnect, and this effect
  // re-subscribes on every keystroke (value is in its deps). Without this guard,
  // each reconnect would re-run setContent and clobber the user's in-progress typing.
  // Reset to false whenever postId changes so the new post loads its content.
  const hasInitializedRef = useRef(false)

  // Link modal state (from main)
  const [isLinkModalOpen, setIsLinkModalOpen] = useState(false)
  const [url, setUrl] = useState("")

  // Collaboration provider - wait for theme to load
  const collabProvider = useMemo(() => {
    if (!isThemeLoaded) return null
    if (postId && enableCollaboration && !readOnly) {
      return CollaborationProvider.getInstance(postId)
    }
    return null
  }, [postId, enableCollaboration, readOnly, isThemeLoaded])

  // Block document manager
  const blockDocManager = useMemo(() => {
    if (collabProvider?.doc) {
      return new BlockDocManager(collabProvider.doc)
    }
    return null
  }, [collabProvider])

  // Block persistence manager
  const persistenceManager = useMemo(() => {
    if (blockDocManager && postId && !readOnly) {
      // If the cached manager was created for a different postId (route
      // navigation /content/edit/1 → /content/edit/2 without unmount), tear it
      // down so we don't save edits for the new post to the previous post's ID.
      // Also reset the run-once init guard so the new post loads its content.
      if (persistenceRef.current && persistencePostIdRef.current !== postId) {
        persistenceRef.current.destroy()
        persistenceRef.current = null
        hasInitializedRef.current = false
      }

      if (!persistenceRef.current) {
        const token = authManager.getAccessToken() || undefined
        const manager = new BlockPersistenceManager(postId, blockDocManager, token, title)

        const handleSaveStart = () => {
          setIsSaving(true)
          setSaveStatus("saving")
          onSaveStart?.()
        }

        const handleSaveSuccess = (revision: number) => {
          setIsSaving(false)
          setSaveStatus("saved")
          setTimeout(() => setSaveStatus(null), 3000)
          onSaveSuccess?.(revision)
        }

        const handleSaveError = (error: Error) => {
          setIsSaving(false)
          setSaveStatus("error")
          console.error("Save failed:", error)
          setTimeout(() => setSaveStatus(null), 5000)
          onSaveError?.(error)
        }

        manager.setCallbacks({
          onSaveStart: handleSaveStart,
          onSaveSuccess: handleSaveSuccess,
          onSaveError: handleSaveError,
        })

        persistenceRef.current = manager
        persistencePostIdRef.current = postId
      }
      return persistenceRef.current
    }
    return null
  }, [blockDocManager, postId, readOnly, onSaveStart, onSaveSuccess, onSaveError])

  // Update titleRef when title changes (no autosave)
  useEffect(() => {
    titleRef.current = title
  }, [title])

  // Editor extensions - include link modal setters for Ctrl+K support
  // Re-compute extensions after theme loads to include theme extensions
  const extensions = useMemo(() => {
    const exts = getExtensions({ collabProvider, maxChars, placeholder, setUrl, setIsLinkModalOpen })()
    console.log(`[Editor] Computing extensions (theme loaded: ${isThemeLoaded}), count: ${exts.length}`)
    return exts
  }, [collabProvider, maxChars, placeholder, isThemeLoaded])

  // Initialize Editor - only after theme loads to prevent schema errors
  const editor = useEditor(
    {
      editable: !readOnly,
      extensions,
      content: !collabProvider ? value || "<p></p>" : undefined,
      // autofocus disabled to prevent race condition with BubbleMenu during mount
      // (docView is null when focus fires, causing coordsAtPos crash)
      // We focus manually via useEffect below
      autofocus: false,
      onUpdate({ editor }) {
        const html = editor.getHTML()
        const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, " ")
        // Defer to avoid "Cannot update component while rendering another" warning
        queueMicrotask(() => onChange(html, text))
      },
      editorProps: {
        attributes: {
          class: "gl-content-editor notion-editor-content",
        },
      },
    },
    // Do NOT include `value` here — it changes on every keystroke via onUpdate→onChange,
    // which would destroy and recreate the editor on every keypress.
    // External value changes are handled by the setContent effect below.
    [extensions, readOnly, collabProvider]
  )

  // Focus editor after mount (deferred to avoid BubbleMenu coordsAtPos crash)
  useEffect(() => {
    if (!editor || readOnly) return
    // Wait for next frame to ensure the view's docView is initialized
    const raf = requestAnimationFrame(() => {
      try {
        editor.commands.focus("end")
      } catch {
        // Silently ignore if editor was destroyed before focus
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [editor, readOnly])

  // Force save function
  const handleForceSave = async () => {
    if (!persistenceManager || isSaving || !editor || !blockDocManager) return

    // Mirror current editor state to BlockDoc before saving
    try {
      const blockDoc = pmToBlockDoc(editor.state.doc)
      blockDocManager.setBlockDocV1(blockDoc)
    } catch (error) {
      console.error("Failed to mirror before save:", error)
    }

    // Update title just before saving
    if (titleRef.current) {
      persistenceManager.setTitle(titleRef.current)
    }
    await persistenceManager.forceSave()
  }

  // Expose functions via ref
  useImperativeHandle(
    ref,
    () => ({
      forceSave: handleForceSave,
      publish: async () => {
        if (!persistenceManager || !postId || isPublishing) return undefined

        setIsPublishing(true)
        onPublishStart?.()

        try {
          const result = await persistenceManager.publish()
          onPublishSuccess?.(result)
          return result
        } catch (error) {
          console.error("Publish failed:", error)
          onPublishError?.(error as Error)
          throw error
        } finally {
          setIsPublishing(false)
        }
      },
      getSaveStatus: () => ({ isSaving, isPublishing, saveStatus }),
    }),
    [persistenceManager, postId, isSaving, isPublishing, saveStatus, onPublishStart, onPublishSuccess, onPublishError]
  )

  // Apply link function (from main)
  const applyLinkWithModal = useCallback(() => {
    if (!editor) return
    applyLink(editor, url, setIsLinkModalOpen)
  }, [editor, url])

  // Open link modal function (from main)
  const openLinkModalWithEditor = useCallback(() => {
    if (!editor) return
    openLinkModal(editor, setUrl, setIsLinkModalOpen)
  }, [editor])

  // Keyboard shortcut for opening link modal (from main)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) return
      if (!editor) return

      const selection = editor.state.selection
      if (selection.empty || selection.from === selection.to) return

      e.preventDefault()
      openLinkModalWithEditor()
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [editor, openLinkModalWithEditor])

  // Collaboration content sync
  useEffect(() => {
    if (!editor || !collabProvider) return
    const onSynced = async (isSynced: boolean) => {
      if (!isSynced) return

      // Run the initial-content load only once for this editor instance.
      // "synced" re-fires on every reconnect; re-running setContent below would
      // overwrite unsaved edits (the "heartbeat" that deletes in-progress typing).
      if (hasInitializedRef.current) {
        if (import.meta.env.DEV) console.debug("[Editor] onSynced re-fired — skipping (already initialized)")
        return
      }
      hasInitializedRef.current = true
      if (import.meta.env.DEV) console.debug("[Editor] onSynced — running one-time content load")

      // Wait for IndexedDB to finish its initial load before deciding whether to seed.
      // On the WS "synced" tick IndexedDB may not have applied yet, so the editor can
      // look empty even though it has cached content. Seeding then would mint fresh Yjs
      // structs that collide with IndexedDB's once it loads — diverging the doc (spurious
      // saves, content/image erased, worse on every reload). After this await the
      // emptiness checks below reflect the real, fully-restored state.
      try {
        await collabProvider.whenSynced
      } catch {
        /* ignore — proceed with whatever state we have */
      }
      if (editor.isDestroyed) return

      const frag = collabProvider.doc.getXmlFragment("default")
      const emptyShared = frag.length === 0
      const emptyLocal = editor.isEmpty

      if (isSynced && emptyShared && emptyLocal && value && value !== "<p></p>") {
        editor.commands.setContent(value, { emitUpdate: false })
      }

      if (blockDocManager) {
        const blockDoc = blockDocManager.getBlockDocV1()
        const hasBlockDoc = blockDoc.blocks_order.length > 0 || Object.keys(blockDoc.blocks).length > 0

        if (!hasBlockDoc) {
          if (!editor.isEmpty) {
            const snapshot = pmToBlockDoc(editor.state.doc)
            blockDocManager.setBlockDocV1(snapshot)
          } else {
            blockDocManager.initializeDoc()
          }
        }
      }

      // Set editor instance and initialize persistence manager if available
      if (persistenceManager) {
        persistenceManager.setEditor(editor)

        // Provide sync callback so persistence manager can sync editor state before save/publish
        persistenceManager.setSyncCallback(() => {
          if (!blockDocManager) return
          try {
            const blockDoc = pmToBlockDoc(editor.state.doc)
            blockDocManager.setBlockDocV1(blockDoc)
          } catch (error) {
            console.error("Failed to sync editor to BlockDoc:", error)
          }
        })

        persistenceManager.initialize()
      }

      collabProvider.provider.off("synced", onSynced)
    }

    collabProvider.provider.on("synced", onSynced)
    return () => collabProvider.provider.off("synced", onSynced)
  }, [editor, collabProvider, value, blockDocManager, persistenceManager])

  // Autosave trigger: notify the persistence manager on every editor edit.
  // The manager debounces and mirrors editor → BlockDoc once per save (see
  // BlockPersistenceManager.notifyEditorChange / performSave). Without this,
  // typing never reaches the working copy (block_doc) — only publish did.
  useEffect(() => {
    if (!editor || !persistenceManager) return
    const handleEditorUpdate = () => persistenceManager.notifyEditorChange()
    editor.on("update", handleEditorUpdate)
    return () => {
      editor.off("update", handleEditorUpdate)
    }
  }, [editor, persistenceManager])

  // External content changes (e.g. loading existing post)
  useEffect(() => {
    if (!editor) return
    const current = editor.getHTML()

    if (value !== current && !collabProvider) {
      editor.commands.setContent(value || "<p></p>", {
        emitUpdate: false,
      })
    }
  }, [value, editor, collabProvider])

  // Cleanup collaboration provider on unmount
  useEffect(() => {
    if (!postId || !collabProvider) return
    return () => {
      CollaborationProvider.release(postId)
    }
  }, [postId, collabProvider])

  // Cleanup persistence manager on unmount
  useEffect(() => {
    return () => {
      if (persistenceRef.current) {
        persistenceRef.current.destroy()
        persistenceRef.current = null
      }
    }
  }, [])

  // Subscribe to auth changes and update persistence manager token
  useEffect(() => {
    if (!persistenceRef.current) return

    const unsubscribe = authManager?.subscribe?.((state: any) => {
      const newToken = state?.accessToken ?? null
      persistenceRef.current?.setAuthToken(newToken)
    })

    return () => {
      if (typeof unsubscribe === "function") {
        unsubscribe()
      }
    }
  }, [])

  if (!editor) return null

  if (import.meta.env.DEV && blockDocManager) {
    ;(window as any).blockDocManager = blockDocManager
    const w = window as any
    if (!w.__blockSpecTestLoaded) {
      w.__blockSpecTestLoaded = true
      createTestScript()
    }
  }

  // Show loading state while theme is loading or editor is initializing
  if (!isThemeLoaded || !editor) {
    return (
      <div className="notion-editor">
        <div
          className="editor-wrapper"
          style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "200px" }}
        >
          <p style={{ color: "#999" }}>{!isThemeLoaded ? "Loading theme..." : "Initializing editor..."}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="notion-editor">
      <BubbleMenu editor={editor} openLinkModal={openLinkModalWithEditor} />
      <BlockTypeToolbar editor={editor} />
      <DragHandle editor={editor} />
      <MediaSelector editor={editor} postId={postId} />

      <div className="editor-wrapper">
        <EditorContent editor={editor} />
      </div>

      {isLinkModalOpen && (
        <LinkModal
          editor={editor}
          setIsLinkModalOpen={setIsLinkModalOpen}
          applyLink={applyLinkWithModal}
          url={url}
          setUrl={setUrl}
        />
      )}
      <CharacterCount editor={editor} minChars={minChars} maxChars={maxChars} />
    </div>
  )
})

// Theme gate: only mount the editor once the theme (and its TipTap block/extension
// registry) has loaded, so the editor is created exactly ONCE with the full extension
// set. Previously the editor was built with base extensions before the theme loaded and
// then recreated when `isThemeLoaded` flipped (extensions + collabProvider are in the
// useEditor deps), causing a double create in production (#198). This must be a separate
// wrapper component — an early return before `useEditor` inside EditorInner would change
// the hook count between renders and violate the Rules of Hooks.
export default forwardRef<EditorRef, Props>(function Editor(props, ref) {
  const { isThemeLoaded } = useTheme()

  if (!isThemeLoaded) {
    return (
      <div className="notion-editor">
        <div
          className="editor-wrapper"
          style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "200px" }}
        >
          <p style={{ color: "#999" }}>Loading theme…</p>
        </div>
      </div>
    )
  }

  return <EditorInner ref={ref} {...props} />
})
