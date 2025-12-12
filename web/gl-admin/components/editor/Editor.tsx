import { useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle, useCallback } from "react"
import { EditorContent, useEditor } from "@tiptap/react"
import { CollaborationProvider } from "@gl-admin/lib/collaboration/CollaborationProvider"
import { BlockDocManager } from "@gl-admin/lib/collaboration/BlockDocManager"
import { BlockPersistenceManager } from "@gl-admin/lib/collaboration/BlockPersistenceManager"
import { pmToBlockDoc } from "@gl-admin/lib/collaboration/blockBridge"
import { createTestScript } from "@gl-admin/lib/test/blockSpecTest"
import { authManager } from "@gl-admin/lib/auth"
import { applyLink, openLinkModal } from "./utils/linkManager"
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

export default forwardRef<EditorRef, Props>(function Editor(
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
  const [isSaving, setIsSaving] = useState(false)
  const [isPublishing, setIsPublishing] = useState(false)
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "error" | null>(null)
  const persistenceRef = useRef<BlockPersistenceManager | null>(null)
  const titleRef = useRef<string | undefined>(title)

  // Link modal state (from main)
  const [isLinkModalOpen, setIsLinkModalOpen] = useState(false)
  const [url, setUrl] = useState("")

  // Collaboration provider
  const collabProvider = useMemo(() => {
    if (postId && enableCollaboration && !readOnly) {
      return CollaborationProvider.getInstance(postId)
    }
    return null
  }, [postId, enableCollaboration, readOnly])

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
  const extensions = useMemo(
    () => getExtensions({ collabProvider, maxChars, placeholder, setUrl, setIsLinkModalOpen })(),
    [collabProvider, maxChars, placeholder]
  )

  // Initialize Editor
  const editor = useEditor({
    editable: !readOnly,
    extensions,
    content: !collabProvider ? value || "<p></p>" : undefined,
    autofocus: "end",
    onUpdate({ editor }) {
      const html = editor.getHTML()
      const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, " ")
      onChange(html, text)
    },
    editorProps: {
      attributes: {
        class: "gl-content-editor notion-editor-content",
      },
    },
  })

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
    const onSynced = (isSynced: boolean) => {
      if (!isSynced) return

      const frag = collabProvider.doc.getXmlFragment("prosemirror")
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
