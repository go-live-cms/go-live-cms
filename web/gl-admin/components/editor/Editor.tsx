import React, { useEffect, useState, useCallback } from "react"
import { EditorContent, useEditor, ReactRenderer } from "@tiptap/react"
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
import FeaturedImageSelector from "./FeaturedImageSelector"
import { getMediaURL } from "@gl-admin/lib/api"
import { createPostMedia } from "@gl-admin/lib/api/posts"
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

  const insertImagePlaceholder = useCallback((editor: TiptapEditor, range: { from: number; to: number }) => {
    const placeholderSrc = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='200' viewBox='0 0 400 200'%3E%3Crect width='400' height='200' fill='%23f3f4f6' stroke='%23d1d5db' stroke-width='2' stroke-dasharray='5,5'/%3E%3Cg transform='translate(200,100)'%3E%3Ccircle cx='0' cy='-20' r='20' fill='%23a3a3a3'/%3E%3Cpath d='M-15,-10 L-5,-10 L0,-5 L5,-10 L15,-10 L15,10 L-15,10 Z' fill='%23a3a3a3'/%3E%3C/g%3E%3Ctext x='50%25' y='70%25' dominant-baseline='middle' text-anchor='middle' fill='%23666' font-family='system-ui' font-size='14'%3EClick to select image from library%3C/text%3E%3C/svg%3E"
    
    editor.chain()
      .focus()
      .deleteRange(range)
      .setImage({ 
        src: placeholderSrc
      })
      .run()
  }, [])

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
      description: "Add an image from media library",
      icon: "🖼️",
      command: ({ editor, range }) => {
        insertImagePlaceholder(editor, range)
      },
      aliases: ["img", "image", "picture"],
    },
  ]

  const getCursorCoords = useCallback((editor: TiptapEditor, range: { from: number; to: number }) => {
    const { view } = editor
    const { from } = range

    try {
      const coords = view.coordsAtPos(from)

      const editorRect = view.dom.getBoundingClientRect()

      return {
        x: coords.left,
        y: coords.bottom,
        left: coords.left,
        right: coords.right,
        top: coords.top,
        bottom: coords.bottom,
        width: coords.right - coords.left,
        height: coords.bottom - coords.top,
      }
    } catch (error) {
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
        class: "ProseMirror notion-editor-content",
        "data-placeholder": placeholder,
      },
    },
  })

  useEffect(() => {
    if (editor && value !== editor.getHTML()) {
      editor.commands.setContent(value || "<p></p>", {
        emitUpdate: false,
      })
    }
  }, [value, editor])

  const handleMediaSelect = useCallback(async (media: Media) => {
    if (!editor || pendingImagePosition === null) return
    
    const imageUrl = getMediaURL(media.media_path)
    
    const { view } = editor
    const { state } = view
    const { doc } = state
    
    const resolvedPos = doc.resolve(pendingImagePosition)
    const imageNode = resolvedPos.nodeAfter
    
    if (imageNode && imageNode.type.name === 'image') {
      const transaction = state.tr.setNodeMarkup(
        pendingImagePosition,
        imageNode.type,
        {
          src: imageUrl,
          alt: media.alt || media.description || '',
          title: media.name || ''
        }
      )
      view.dispatch(transaction)

      if (postId) {
        try {
          await createPostMedia(postId, media.id, 1)
          console.log(`Successfully linked media ${media.id} to post ${postId} as content image`)
        } catch (error) {
          console.error('Failed to link media to post:', error)
        }
      }
    }
    
    setShowMediaSelector(false)
    setPendingImagePosition(null)
  }, [editor, pendingImagePosition, postId])

  const handleMediaSelectorClose = useCallback(() => {
    setShowMediaSelector(false)
    setPendingImagePosition(null)
  }, [])

  useEffect(() => {
    if (!editor) return

    const handleImageClick = (event: MouseEvent) => {
      const target = event.target as HTMLImageElement
      if (target.tagName === 'IMG' && target.src.includes('data:image/svg+xml')) {
        event.preventDefault()
        event.stopPropagation()
        
        const { view } = editor
        const { state } = view
        const { doc } = state
        
        let imagePos = null
        
        doc.descendants((node, pos) => {
          if (node.type.name === 'image' && node.attrs.src.includes('data:image/svg+xml')) {
            const domPos = view.domAtPos(pos)
            if (domPos.node.contains && domPos.node.contains(target)) {
              imagePos = pos
              return false 
            }
          }
        })
        
        if (imagePos !== null) {
          setPendingImagePosition(imagePos)
          setShowMediaSelector(true)
        }
      }
    }

    const editorElement = editor.view.dom
    editorElement.addEventListener('click', handleImageClick)

    return () => {
      editorElement.removeEventListener('click', handleImageClick)
    }
  }, [editor])

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
