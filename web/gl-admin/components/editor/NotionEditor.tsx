import React, { useEffect, useState, useCallback } from "react"
import { EditorContent, useEditor, ReactRenderer } from "@tiptap/react"
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

  // Function to get cursor position
  const getCursorCoords = useCallback((editor: TiptapEditor, range: { from: number; to: number }) => {
    const { view } = editor
    const { from } = range

    try {
      // Get the DOM coordinates at the cursor position
      const coords = view.coordsAtPos(from)

      // Get the editor container position to make coordinates relative to viewport
      const editorRect = view.dom.getBoundingClientRect()

      return {
        x: coords.left,
        y: coords.bottom, // Position below the cursor line (like Notion)
        left: coords.left,
        right: coords.right,
        top: coords.top,
        bottom: coords.bottom,
        width: coords.right - coords.left,
        height: coords.bottom - coords.top,
      }
    } catch (error) {
      console.warn("Could not get cursor coordinates:", error)
      // Fallback coordinates
      const editorRect = view.dom.getBoundingClientRect()
      return {
        x: editorRect.left + 20,
        y: editorRect.top + 40,
        left: editorRect.left + 20,
        right: editorRect.left + 40,
        top: editorRect.top + 20,
        bottom: editorRect.top + 40,
        width: 20,
        height: 20,
      }
    }
  }, [])

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
            let component: ReactRenderer | null = null
            let popup: HTMLElement | null = null

            return {
              onStart: (props: any) => {
                // Use setTimeout to avoid flushSync error
                setTimeout(() => {
                  component = new ReactRenderer(SlashCommandList, {
                    props: {
                      ...props,
                      editor,
                    },
                    editor,
                  })

                  popup = document.createElement("div")
                  popup.className = "slash-command-popup"
                  popup.appendChild(component.element)
                  document.body.appendChild(popup)

                  // Position the popup using our improved coordinate function
                  const coords = getCursorCoords(editor, props.range)

                  popup.style.position = "fixed" // Use fixed instead of absolute
                  popup.style.left = `${coords.x}px`
                  popup.style.top = `${coords.y + 8}px` // 8px below cursor
                  popup.style.zIndex = "9999"
                  popup.style.maxHeight = "300px"
                  popup.style.overflowY = "auto"

                  // Add some basic positioning logic to keep it on screen
                  const popupRect = popup.getBoundingClientRect()
                  const viewportHeight = window.innerHeight
                  const viewportWidth = window.innerWidth

                  // If popup would go off the bottom, position it above the cursor
                  if (coords.y + popupRect.height + 8 > viewportHeight) {
                    popup.style.top = `${coords.y - popupRect.height - 8}px`
                  }

                  // If popup would go off the right, move it left
                  if (coords.x + popupRect.width > viewportWidth) {
                    popup.style.left = `${viewportWidth - popupRect.width - 8}px`
                  }
                }, 0)
              },
              onUpdate: (props: any) => {
                if (component) {
                  component.updateProps({
                    ...props,
                    editor,
                  })
                }

                // Update position
                if (popup) {
                  const coords = getCursorCoords(editor, props.range)
                  popup.style.left = `${coords.x}px`
                  popup.style.top = `${coords.y + 8}px`

                  // Recheck viewport bounds
                  const popupRect = popup.getBoundingClientRect()
                  const viewportHeight = window.innerHeight
                  const viewportWidth = window.innerWidth

                  if (coords.y + popupRect.height + 8 > viewportHeight) {
                    popup.style.top = `${coords.y - popupRect.height - 8}px`
                  }

                  if (coords.x + popupRect.width > viewportWidth) {
                    popup.style.left = `${viewportWidth - popupRect.width - 8}px`
                  }
                }
              },
              onKeyDown: (props: any) => {
                if (props.event.key === "Escape") {
                  return true
                }
                return component?.ref?.onKeyDown?.(props) || false
              },
              onExit: () => {
                if (popup && popup.parentNode) {
                  popup.parentNode.removeChild(popup)
                }
                if (component) {
                  component.destroy()
                }
                component = null
                popup = null
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
      <FloatingMenu
        editor={editor}
        className="floating-menu"
        shouldShow={({ editor, state }) => {
          const { selection } = state
          const { $head, empty } = selection

          if (!empty) return false

          const isRootDepth = $head.depth === 1
          const isEmptyTextBlock = $head.parent.isTextblock && !$head.parent.type.spec.code && !$head.parent.textContent

          return isRootDepth && isEmptyTextBlock
        }}
      >
        <button
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          className="floating-menu-btn"
          title="Heading 1"
          type="button"
        >
          H1
        </button>
        <button
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          className="floating-menu-btn"
          title="Heading 2"
          type="button"
        >
          H2
        </button>
        <button
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          className="floating-menu-btn"
          title="Bullet List"
          type="button"
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
          type="button"
        >
          🖼️
        </button>
      </FloatingMenu>

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
