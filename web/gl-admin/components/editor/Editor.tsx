import { useEffect, useMemo, useRef } from "react"
import { EditorContent, useEditor } from "@tiptap/react"
import { CollaborationProvider } from "@gl-admin/lib/collaboration/CollaborationProvider"
import { BlockDocManager } from "@gl-admin/lib/collaboration/BlockDocManager"
import { pmToBlockDoc } from "@gl-admin/lib/collaboration/blockBridge"
import { createTestScript } from "@gl-admin/lib/test/blockSpecTest"
import BubbleMenu from "./ui/BubbleMenu"
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
  enableCollaboration?: boolean
}

export default function Editor({
  value,
  onChange,
  placeholder = "Type '/' for commands...",
  readOnly = false,
  minChars,
  maxChars,
  postId,
  enableCollaboration = true,
}: Props) {
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

  const mirrorTimer = useRef<number | null>(null)

  // Editor extensions
  const extensions = useMemo(getExtensions({ collabProvider, maxChars, placeholder }), [
    collabProvider,
    maxChars,
    placeholder,
  ])

  // Initialize Editor
  const editor = useEditor({
    editable: !readOnly,
    extensions,
    content: !collabProvider ? value || "<p></p>" : undefined,
    autofocus: "end",
    onUpdate({ editor, transaction }) {
      const html = editor.getHTML()
      const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, " ")
      onChange(html, text)

      if (blockDocManager && transaction.docChanged) {
        if (mirrorTimer.current) {
          window.clearTimeout(mirrorTimer.current)
        }

        mirrorTimer.current = window.setTimeout(() => {
          if (!blockDocManager) {
            return
          }

          try {
            const blockDoc = pmToBlockDoc(editor.state.doc)
            blockDocManager.setBlockDocV1(blockDoc)

            if (import.meta.env.DEV) {
              console.log("Mirrored to BlockDoc:", blockDoc)
            }
          } catch (error) {
            console.error("Failed to mirror to BlockDoc:", error)
          } finally {
            mirrorTimer.current = null
          }
        }, 200)
      }
    },
    editorProps: {
      attributes: {
        class: "gl-content-editor notion-editor-content",
      },
    },
  })

  useEffect(() => {
    return () => {
      if (mirrorTimer.current) {
        window.clearTimeout(mirrorTimer.current)
      }
    }
  }, [])

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
        const hasBlockDoc =
          blockDoc.blocks_order.length > 0 || Object.keys(blockDoc.blocks).length > 0

        if (!hasBlockDoc) {
          if (!editor.isEmpty) {
            const snapshot = pmToBlockDoc(editor.state.doc)
            blockDocManager.setBlockDocV1(snapshot)
          } else {
            blockDocManager.initializeDoc()
          }
        }
      }

      collabProvider.provider.off("synced", onSynced)
    }

    collabProvider.provider.on("synced", onSynced)
    return () => collabProvider.provider.off("synced", onSynced)
  }, [editor, collabProvider, value, blockDocManager])

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

  if (!editor) return null

  if (import.meta.env.DEV && blockDocManager) {
    ;(window as any).blockDocManager = blockDocManager
    createTestScript()
  }

  return (
    <div className="notion-editor">
      <BubbleMenu editor={editor} />
      <DragHandle editor={editor} />
      <MediaSelector editor={editor} postId={postId} />

      <div className="editor-wrapper">
        <EditorContent editor={editor} />
      </div>

      <CharacterCount editor={editor} minChars={minChars} maxChars={maxChars} />
    </div>
  )
}
