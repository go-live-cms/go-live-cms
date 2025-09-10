import React, { useEffect, useState, useCallback } from "react"
import { EditorContent, useEditor, ReactRenderer } from "@tiptap/react"
import DragHandle from '@tiptap/extension-drag-handle-react'
import { BubbleMenu } from "@tiptap/react/menus"
import StarterKit from "@tiptap/starter-kit"
import Placeholder from "@tiptap/extension-placeholder"
import Link from "@tiptap/extension-link"
import Image from "@tiptap/extension-image"
import Underline from "@tiptap/extension-underline"
import TextAlign from "@tiptap/extension-text-align"
import CharacterCount from "@tiptap/extension-character-count"
import Typography from "@tiptap/extension-typography"
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight"
import { createLowlight, common } from "lowlight"
import type { Editor as TiptapEditor } from "@tiptap/core"
import { SlashCommandExtension, SlashCommandList, type SlashCommandItem } from "./SlashCommand"
import { slashCommandManager } from "./SlashCommandManager"
import { getCursorCoords } from "./utils/cursorCoords"
import { applyTurnInto, computeTurnIntoFromSelection, type TurnIntoValue } from "./utils/TurnInto"
import CommandSelect, { type CommandSelectOption } from "./ui/CommandSelect"
import { getSlashCommandItems, getTurnIntoCommandOptions } from "./blocks"
import { MediaBlockManager } from "./blocks/mediaBlocks"
import FeaturedImageSelector from "./FeaturedImageSelector"
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
}: Props) {
  const [showMediaSelector, setShowMediaSelector] = useState(false)
  const [pendingImagePosition, setPendingImagePosition] = useState<number | null>(null)
  const [mediaBlockManager, setMediaBlockManager] = useState<MediaBlockManager | null>(null)

  const getSlashCommands = (editor: TiptapEditor): SlashCommandItem[] => {
    return getSlashCommandItems()
  }

  const [showDrag, setShowDrag] = useState(false)
  const onDragHandleNodeChange = useCallback((data: { node: any; editor: TiptapEditor; pos: number }) => {
    if (data.node && data.node.textContent && data.node.textContent.trim().length > 0) {
      setShowDrag(true)
    }
    else {
      setShowDrag(false)
    }
  }, [])

  const headingLabel = (lvl?: number) => {
    switch (lvl) {
      case 1: return "Heading 1…";
      case 2: return "Heading 2…";
      case 3: return "Heading 3…";
      default: return "Heading…";
    }
  };

  const editor = useEditor({
    editable: !readOnly,
    content: value || "<p></p>",
    autofocus: "end",
    extensions: [
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
      Underline,
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
              return "Write code…";
            case "blockquote":
              return "Write a quote…";
            case "horizontalRule":
              return "";
            case "image":
              return "";
            case "heading":
              return headingLabel(node.attrs?.level);
            case "listItem":
              return editor.isActive("orderedList")
                ? "List item…"
                : "List item…";
            case "paragraph":
            default: {
              if (editor.isActive("codeBlock")) return "Write code…";
              if (editor.isActive("blockquote")) return "Write a quote…";
              if (editor.isActive("orderedList")) return "List item…";
              if (editor.isActive("bulletList")) return "List item…";
              if (editor.isActive("heading", { level: 1 })) return headingLabel(1);
              if (editor.isActive("heading", { level: 2 })) return headingLabel(2);
              if (editor.isActive("heading", { level: 3 })) return headingLabel(3);
              return placeholder || "Type '/' for commands…";
            }
          }
        },
      }),
      CharacterCount.configure({ limit: maxChars }),
      SlashCommandExtension.configure({
        suggestion: {
          items: ({ query }: { query: string }) => {
            if (!editor) return []

            const commands = getSlashCommands(editor)
            return commands
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
          render: () => {
            return {
              onStart: (props: any) => {
                slashCommandManager.start(props, getCursorCoords)
              },

              onUpdate: (props: any) => {
                slashCommandManager.update(props, getCursorCoords)
              },

              onKeyDown: (props: any) => {
                return slashCommandManager.handleKeyDown(props)
              },

              onExit: () => {
                slashCommandManager.exit()
              },
            }
          },
        },
      }),
    ],
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

  const [turnIntoOptions, setTurnIntoOptions] = useState<CommandSelectOption[]>([])
  const [turnInto, setTurnInto] = useState<TurnIntoValue>('paragraph')

  useEffect(() => {
    if (!editor) return
    setTurnIntoOptions(getTurnIntoCommandOptions())
    setTurnInto(computeTurnIntoFromSelection(editor))
  }, [editor])

  const updateTurnInto = useCallback(() => {
    if (!editor) return
    const v = computeTurnIntoFromSelection(editor)
    setTurnInto(v)
  }, [editor])

  useEffect(() => {
    if (!editor) return
    editor.on('selectionUpdate', updateTurnInto)
    editor.on('transaction', updateTurnInto)
    return () => {
      editor.off('selectionUpdate', updateTurnInto)
      editor.off('transaction', updateTurnInto)
    }
  }, [editor, updateTurnInto])

  useEffect(() => {
    if (!editor) return
    const current = editor.getHTML()

    if (value !== current) {
      editor.commands.setContent(value || "<p></p>", {
        emitUpdate: false,
      })
      setTurnInto(computeTurnIntoFromSelection(editor))
    }
  }, [value, editor])


  useEffect(() => {
    if (editor) {
      const manager = new MediaBlockManager(
        editor,
        postId,
        (position: number) => {
          setPendingImagePosition(position)
          setShowMediaSelector(true)
        }
      )
      setMediaBlockManager(manager)

      return () => {
        manager.destroy()
      }
    }
  }, [editor, postId])

  const handleMediaSelect = useCallback(async (media: Media) => {
    if (!mediaBlockManager || pendingImagePosition === null) return
    await mediaBlockManager.handleMediaSelect(media, pendingImagePosition)
    setShowMediaSelector(false)
    setPendingImagePosition(null)
  }, [mediaBlockManager, pendingImagePosition])

  const handleMediaSelectorClose = useCallback(() => {
    setShowMediaSelector(false)
    setPendingImagePosition(null)
  }, [])

  if (!editor) return null

  return (
    <div className="notion-editor">
      {/* Bubble Menu - appears when text is selected */}
      <BubbleMenu editor={editor} className="bubble-menu">
        <button
          onClick={() => editor.chain().focus().toggleBold().run()}
          className={`bubble-menu-btn ${editor.isActive("bold") ? "active" : ""}`}
          type="button"
        >
          <strong>B</strong>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleItalic().run()}
          className={`bubble-menu-btn ${editor.isActive("italic") ? "active" : ""}`}
          type="button"
        >
          <em>I</em>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          className={`bubble-menu-btn ${editor.isActive("underline") ? "active" : ""}`}
          type="button"
        >
          <u>U</u>
        </button>
        <button
          onClick={() => {
            const url = window.prompt("URL")
            if (url) editor.chain().focus().setLink({ href: url }).run()
          }}
          className={`bubble-menu-btn ${editor.isActive("link") ? "active" : ""}`}
          type="button"
        >
          🔗
        </button>
        <CommandSelect
          options={turnIntoOptions}
          value={turnInto}
          label="Turn into"
          onChange={(option: CommandSelectOption) => {
            if (!editor) return
            const val = option.value as TurnIntoValue
            setTurnInto(val)
            applyTurnInto(editor, val, turnIntoOptions)
          }}
        />
      </BubbleMenu>
      {/* Drag Handle */}
      <DragHandle editor={editor} onNodeChange={onDragHandleNodeChange} className={`drag-handle-wrapper ${showDrag ? 'visible' : 'hidden'}`}>
        <div className="drag-handle" title="Drag to move block">
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
