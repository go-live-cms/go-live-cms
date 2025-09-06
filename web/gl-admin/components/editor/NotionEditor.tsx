import React, { useEffect, useState, useRef } from "react"
import { EditorContent, useEditor } from "@tiptap/react"
import { BubbleMenu, FloatingMenu } from "@tiptap/react/menus"
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
import "@gl-admin/assets/styles/components/editor/notion-editor.scss"

type Props = {
  value: string
  onChange: (html: string, plainText: string) => void
  placeholder?: string
  readOnly?: boolean
  minChars?: number
  maxChars?: number
}

const lowlight = createLowlight(common)

export default function NotionEditor({
  value,
  onChange,
  placeholder = "Type '/' for commands...",
  readOnly = false,
  minChars,
  maxChars,
}: Props) {
  const [isSlashOpen, setIsSlashOpen] = useState(false)
  const slashCommandRef = useRef<any>("")

  // Slash command items
  const getSlashCommands = (editor: TiptapEditor): SlashCommandItem[] => [
    {
      title: "Heading 1",
      description: "Large section heading",
      icon: "📝",
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).setHeading({ level: 1 }).run()
      },
      aliases: ["h1", "heading1"],
    },
    {
      title: "Heading 2",
      description: "Medium section heading",
      icon: "📄",
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).setHeading({ level: 2 }).run()
      },
      aliases: ["h2", "heading2"],
    },
    {
      title: "Heading 3",
      description: "Small section heading",
      icon: "📃",
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).setHeading({ level: 3 }).run()
      },
      aliases: ["h3", "heading3"],
    },
    {
      title: "Bullet List",
      description: "Create a simple bullet list",
      icon: "•",
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).toggleBulletList().run()
      },
      aliases: ["ul", "list"],
    },
    {
      title: "Numbered List",
      description: "Create a numbered list",
      icon: "1.",
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).toggleOrderedList().run()
      },
      aliases: ["ol", "ordered"],
    },
    {
      title: "Quote",
      description: "Add a blockquote",
      icon: "💬",
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).setBlockquote().run()
      },
      aliases: ["quote", "blockquote"],
    },
    {
      title: "Code Block",
      description: "Add a code block with syntax highlighting",
      icon: "💻",
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).setCodeBlock().run()
      },
      aliases: ["code", "codeblock"],
    },
    {
      title: "Divider",
      description: "Add a horizontal divider",
      icon: "➖",
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).setHorizontalRule().run()
      },
      aliases: ["hr", "divider", "separator"],
    },
    {
      title: "Image",
      description: "Add an image",
      icon: "🖼️",
      command: ({ editor, range }) => {
        const url = window.prompt("Image URL")
        if (url) {
          editor.chain().focus().deleteRange(range).setImage({ src: url }).run()
        }
      },
      aliases: ["img", "image", "picture"],
    },
  ]

  const editor = useEditor({
    editable: !readOnly,
    content: value || "<p></p>",
    autofocus: "end",
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        codeBlock: false,
        dropcursor: { width: 2, color: "var(--editor-cursor,#3b82f6)" },
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
      Placeholder.configure({ placeholder }),
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
            let component: any
            let popup: any

            return {
              onStart: (props: any) => {
                setIsSlashOpen(true)
                component = new SlashCommandList({
                  items: props.items,
                  command: props.command,
                })
              },
              onUpdate: (props: any) => {
                component?.updateProps?.(props)
              },
              onKeyDown: (props: any) => {
                if (props.event.key === "Escape") {
                  setIsSlashOpen(false)
                  return true
                }
                return component?.ref?.onKeyDown?.(props)
              },
              onExit: () => {
                setIsSlashOpen(false)
                popup?.destroy?.()
                component?.destroy?.()
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
        class: "ProseMirror notion-editor-content",
        "data-placeholder": placeholder,
      },
      handleDOMEvents: {
        keydown: (view, event) => {
          // Handle keyboard shortcuts
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            // Submit on Cmd/Ctrl + Enter
            return false
          }
          return false
        },
      },
    },
  })

  useEffect(() => {
    if (editor && value !== editor.getHTML()) {
      editor.commands.setContent(value || "<p></p>", false)
    }
  }, [value, editor])

  if (!editor) return null

  return (
    <div className="notion-editor">
      {/* Floating Menu - appears on empty lines */}
      <FloatingMenu editor={editor} tippyOptions={{ duration: 100, placement: "left" }} className="floating-menu">
        <button
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          className="floating-menu-btn"
          title="Heading 1"
        >
          H1
        </button>
        <button
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          className="floating-menu-btn"
          title="Heading 2"
        >
          H2
        </button>
        <button
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          className="floating-menu-btn"
          title="Bullet List"
        >
          •
        </button>
        <button
          onClick={() => {
            const url = window.prompt("Image URL")
            if (url) editor.chain().focus().setImage({ src: url }).run()
          }}
          className="floating-menu-btn"
          title="Add Image"
        >
          🖼️
        </button>
      </FloatingMenu>

      {/* Bubble Menu - appears when text is selected */}
      <BubbleMenu editor={editor} tippyOptions={{ duration: 100 }} className="bubble-menu">
        <button
          onClick={() => editor.chain().focus().toggleBold().run()}
          className={`bubble-menu-btn ${editor.isActive("bold") ? "active" : ""}`}
        >
          <strong>B</strong>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleItalic().run()}
          className={`bubble-menu-btn ${editor.isActive("italic") ? "active" : ""}`}
        >
          <em>I</em>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          className={`bubble-menu-btn ${editor.isActive("underline") ? "active" : ""}`}
        >
          <u>U</u>
        </button>
        <button
          onClick={() => {
            const url = window.prompt("URL")
            if (url) editor.chain().focus().setLink({ href: url }).run()
          }}
          className={`bubble-menu-btn ${editor.isActive("link") ? "active" : ""}`}
        >
          🔗
        </button>
      </BubbleMenu>

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
    </div>
  )
}
