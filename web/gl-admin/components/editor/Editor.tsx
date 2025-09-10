import { useEffect, useState, useCallback, useMemo } from "react"
import { EditorContent, useEditor, ReactRenderer } from "@tiptap/react"
import DragHandle from "@tiptap/extension-drag-handle-react"
import StarterKit from "@tiptap/starter-kit"
import Collaboration from "@tiptap/extension-collaboration"
import { CursorAwareness } from "./CursorAwareness"
import Placeholder from "@tiptap/extension-placeholder"
import Link from "@tiptap/extension-link"
import Image from "@tiptap/extension-image"
import TextAlign from "@tiptap/extension-text-align"
import CharacterCount from "@tiptap/extension-character-count"
import Typography from "@tiptap/extension-typography"
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight"
import { createLowlight, common } from "lowlight"
import type { Editor as TiptapEditor } from "@tiptap/core"
import { SlashCommandExtension } from "./SlashCommand"
import { slashCommandManager } from "./SlashCommandManager"
import { getCursorCoords } from "./utils/cursorCoords"
import BubbleMenu from "./ui/BubbleMenu"
import { getSlashCommandItems, getTurnIntoCommandOptions } from "./blocks"
import { MediaBlockManager } from "./blocks/mediaBlocks"
import FeaturedImageSelector from "./FeaturedImageSelector"
import { CollaborationProvider } from "@gl-admin/lib/collaboration/CollaborationProvider"
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

const lowlight = createLowlight(common)

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

  const headingLabel = (lvl?: number) => {
    switch (lvl) {
      case 1:
        return "Heading 1…"
      case 2:
        return "Heading 2…"
      case 3:
        return "Heading 3…"
      default:
        return "Heading…"
    }
  }

  // Extensions with both collaboration and drag handle
  const extensions = useMemo(() => {
    const baseExtensions = [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        codeBlock: false,
        dropcursor: { width: 2, color: "var(--editor-cursor,#3b82f6)" },
        link: false,
      }),
      CodeBlockLowlight.configure({
        lowlight,
        defaultLanguage: "javascript",
      }),
      Typography,
      Link.configure({
        autolink: true,
        openOnClick: false,
        validate: (href) => /^https?:\/\//.test(href),
        HTMLAttributes: {
          class: "editor-link",
        },
      }),
      Image.configure({
        allowBase64: false,
        HTMLAttributes: {
          class: "editor-image",
        },
      }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Placeholder.configure({
        includeChildren: true,
        showOnlyWhenEditable: true,
        placeholder: ({ node, editor }) => {
          switch (node.type.name) {
            case "codeBlock":
              return "Write code…"
            case "blockquote":
              return "Write a quote…"
            case "horizontalRule":
              return ""
            case "image":
              return ""
            case "heading":
              return headingLabel(node.attrs?.level)
            case "listItem":
              return editor.isActive("orderedList") ? "List item…" : "List item…"
            case "paragraph":
            default: {
              if (editor.isActive("codeBlock")) return "Write code…"
              if (editor.isActive("blockquote")) return "Write a quote…"
              if (editor.isActive("orderedList")) return "List item…"
              if (editor.isActive("bulletList")) return "List item…"
              if (editor.isActive("heading", { level: 1 })) return headingLabel(1)
              if (editor.isActive("heading", { level: 2 })) return headingLabel(2)
              if (editor.isActive("heading", { level: 3 })) return headingLabel(3)
              return placeholder || "Type '/' for commands…"
            }
          }
        },
      }),
      CharacterCount.configure({ limit: maxChars }),
      SlashCommandExtension.configure({
        suggestion: {
          items: ({ query }: { query: string }) => {
            return getSlashCommandItems()
              .filter((item) => {
                const searchTerm = query.toLowerCase()
                return (
                  item.title.toLowerCase().includes(searchTerm) ||
                  item.description.toLowerCase().includes(searchTerm) ||
                  (item.aliases && item.aliases.some((alias) => alias.includes(searchTerm)))
                )
              })
              .slice(0, 10)
          },
          render: () => ({
            onStart: (props: any) => slashCommandManager.start(props, getCursorCoords),
            onUpdate: (props: any) => slashCommandManager.update(props, getCursorCoords),
            onKeyDown: (props: any) => slashCommandManager.handleKeyDown(props),
            onExit: () => slashCommandManager.exit(),
          }),
        },
      }),
    ]

    // Add collaboration extensions (your feature)
    if (collabProvider) {
      const userState = collabProvider.provider.awareness.getLocalState()
      console.log("Setting up collaboration for user:", userState?.user)
      console.log("CollabProvider doc exists:", !!collabProvider.doc)
      console.log("CollabProvider provider exists:", !!collabProvider.provider)

      if (collabProvider.doc && collabProvider.provider && collabProvider.provider.awareness) {
        baseExtensions.push(
          Collaboration.configure({
            document: collabProvider.doc,
          })
        )

        console.log("Added Collaboration extension successfully")

        const awareness = collabProvider.provider.awareness
        baseExtensions.push(CursorAwareness.configure({ awareness }))
        console.log("Added CursorAwareness extension successfully")
      } else {
        console.warn("CollaborationProvider not fully initialized, skipping collaboration extensions")
      }
    }

    return baseExtensions
  }, [collabProvider, maxChars, placeholder])

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
