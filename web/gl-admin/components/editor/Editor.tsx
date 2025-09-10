import { useEffect, useState, useCallback, useMemo } from "react"
import { EditorContent, useEditor, ReactRenderer } from "@tiptap/react"
import type { Editor as TiptapEditor } from "@tiptap/core"
import { CollaborationProvider } from "@gl-admin/lib/collaboration/CollaborationProvider"
import DragHandle from "@tiptap/extension-drag-handle-react"
import BubbleMenu from "./ui/BubbleMenu"
import { MediaBlockManager } from "./blocks/mediaBlocks"
import FeaturedImageSelector from "./FeaturedImageSelector"
import { getExtensions } from "./utils/extensions"
import type { Media } from "@gl-admin/lib/api/types"
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
  const [showMediaSelector, setShowMediaSelector] = useState(false)
  const [pendingImagePosition, setPendingImagePosition] = useState<number | null>(null)
  const [mediaBlockManager, setMediaBlockManager] = useState<MediaBlockManager | null>(null)

  // Collaboration provider (your feature)
  const collabProvider = useMemo(() => {
    if (postId && enableCollaboration && !readOnly) {
      return CollaborationProvider.getInstance(postId)
    }
    return null
  }, [postId, enableCollaboration, readOnly])

  // Drag handle state (main branch feature)
  const [showDrag, setShowDrag] = useState(false)
  const onDragHandleNodeChange = useCallback((data: { node: any; editor: TiptapEditor; pos: number }) => {
    if (data.node && data.node.textContent && data.node.textContent.trim().length > 0) {
      setShowDrag(true)
    } else {
      setShowDrag(false)
    }
  }, [])

  // Extensions with both collaboration and drag handle
  const extensions = useMemo(getExtensions({ collabProvider, maxChars, placeholder }), [collabProvider, maxChars, placeholder])

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

  // Collaboration synced seeding (your feature)
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
      collabProvider.provider.off("synced", onSynced)
    }
    collabProvider.provider.on("synced", onSynced)
    return () => collabProvider.provider.off("synced", onSynced)
  }, [editor, collabProvider, value])

  // Content updates for non-collaboration mode
  useEffect(() => {
    if (!editor) return
    const current = editor.getHTML()

    if (value !== current && !collabProvider) {
      editor.commands.setContent(value || "<p></p>", {
        emitUpdate: false,
      })
    }
  }, [value, editor, collabProvider])

  // Media block manager
  useEffect(() => {
    if (editor) {
      const manager = new MediaBlockManager(editor, postId, (position: number) => {
        setPendingImagePosition(position)
        setShowMediaSelector(true)
      })
      setMediaBlockManager(manager)
    }
  }, [editor, postId])

  // Collaboration provider cleanup (your feature)
  useEffect(() => {
    if (!postId || !collabProvider) return
    return () => {
      CollaborationProvider.release(postId)
    }
  }, [postId, collabProvider])

  const handleMediaSelect = useCallback(
    async (media: Media) => {
      if (!mediaBlockManager || pendingImagePosition === null) return
      await mediaBlockManager.handleMediaSelect(media, pendingImagePosition)
      setShowMediaSelector(false)
      setPendingImagePosition(null)
    },
    [mediaBlockManager, pendingImagePosition]
  )

  const handleMediaSelectorClose = useCallback(() => {
    setShowMediaSelector(false)
    setPendingImagePosition(null)
  }, [])

  if (!editor) return null

  return (
    <div className="notion-editor">
      {/* Bubble Menu - appears when text is selected */}
      <BubbleMenu editor={editor} />
      {/* Drag Handle */}
      <DragHandle editor={editor} onNodeChange={onDragHandleNodeChange}>
        <div
          className={[
            'flex items-center justify-center text-md text-white leading-none',
            'h-6 w-5 mr-1.5 rounded border border-gray-600 cursor-grab select-none',
            'bg-gray-800 hover:bg-gray-700 transition-delay-500',
            'duration-200',
            showDrag ? 'opacity-80 pointer-events-auto' : 'opacity-0 pointer-events-non',
          ].join(' ')}
          title="Drag to move block"
          onMouseDown={(e) => (e.currentTarget.style.cursor = 'grabbing')}
          onMouseUp={(e) => (e.currentTarget.style.cursor = 'grab')}
        >
          ⋮⋮
        </div>
      </DragHandle>

      {/* Main Editor */}
      <div className="editor-wrapper">
        <EditorContent editor={editor} />
      </div>

      {/* Character Count */}
      <div className="editor-meta">
        <span className="char-count">{editor.storage.characterCount.characters()} characters</span>
        {typeof minChars === "number" && (
          <span className="char-limit">
            min {minChars}
            {editor.storage.characterCount.characters() < minChars ? " • too short" : ""}
          </span>
        )}
        {typeof maxChars === "number" && (
          <span className="char-limit">
            max {maxChars}
            {editor.storage.characterCount.characters() > maxChars ? " • too long" : ""}
          </span>
        )}
      </div>

      {showMediaSelector && (
        <FeaturedImageSelector
          isOpen={showMediaSelector}
          onClose={handleMediaSelectorClose}
          onSelect={handleMediaSelect}
          currentFeaturedImage={null}
        />
      )}
    </div>
  )
}
