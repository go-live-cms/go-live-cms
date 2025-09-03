import React, { useEffect } from "react"
import { EditorContent, useEditor } from "@tiptap/react"
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
import "@gl-admin/assets/styles/components/editor/editor.scss"

type Props = {
  value: string
  onChange: (html: string, plainText: string) => void
  placeholder?: string
  readOnly?: boolean
  minChars?: number
  maxChars?: number
}

const lowlight = createLowlight(common)

export default function NotionLiteEditor({
  value,
  onChange,
  placeholder = "Write something…",
  readOnly = false,
  minChars,
  maxChars,
}: Props) {
  const editor = useEditor({
    editable: !readOnly,
    content: value || "<p></p>",
    autofocus: "end",
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        codeBlock: false,
        history: true,
        dropcursor: { width: 2, color: "var(--editor-cursor,#94a3b8)" },
      }),
      CodeBlockLowlight.configure({ lowlight }),
      Typography,
      Underline,
      Link.configure({ autolink: true, openOnClick: false, validate: (href) => /^https?:\/\//.test(href) }),
      Image.configure({ allowBase64: false }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Placeholder.configure({ placeholder }),
      CharacterCount.configure({ limit: maxChars }),
    ],
    onUpdate({ editor }) {
      const html = editor.getHTML()
      const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, " ")
      onChange(html, text)
    },
    editorProps: {
      attributes: { class: "ProseMirror pm-reset" },
    },
  })

  useEffect(() => {
    if (editor && value !== editor.getHTML()) {
      editor.commands.setContent(value || "<p></p>", false)
    }
  }, [value, editor])

  if (!editor) return null

  return (
    <div className="notion-lite-editor">
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />
      <div className="meta">
        <span>{editor.storage.characterCount.characters()} chars</span>
        {typeof minChars === "number" && (
          <span style={{ marginLeft: 8 }}>
            min {minChars}
            {editor.storage.characterCount.characters() < minChars ? " • too short" : ""}
          </span>
        )}
        {typeof maxChars === "number" && <span style={{ marginLeft: 8 }}>max {maxChars}</span>}
      </div>
    </div>
  )
}

function Toolbar({ editor }: { editor: TiptapEditor }) {
  if (!editor) return null
  const is = (name: string, attrs?: Record<string, unknown>) => editor.isActive(name, attrs)

  return (
    <div className="tiptap-toolbar">
      <button type="button" className={btn(is("bold"))} onClick={() => editor.chain().focus().toggleBold().run()}>
        B
      </button>
      <button type="button" className={btn(is("italic"))} onClick={() => editor.chain().focus().toggleItalic().run()}>
        I
      </button>
      <button
        type="button"
        className={btn(is("underline"))}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      >
        U
      </button>
      <button type="button" className={btn(is("strike"))} onClick={() => editor.chain().focus().toggleStrike().run()}>
        S
      </button>

      <span className="sep" />

      <button
        type="button"
        className={btn(is("heading", { level: 1 }))}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
      >
        H1
      </button>
      <button
        type="button"
        className={btn(is("heading", { level: 2 }))}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        H2
      </button>
      <button
        type="button"
        className={btn(is("heading", { level: 3 }))}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
      >
        H3
      </button>

      <span className="sep" />

      <button
        type="button"
        className={btn(is("bulletList"))}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        • List
      </button>
      <button
        type="button"
        className={btn(is("orderedList"))}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        1. List
      </button>
      <button
        type="button"
        className={btn(is("blockquote"))}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      >
        ❝
      </button>
      <button
        type="button"
        className={btn(is("codeBlock"))}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
      >
        {"</>"}
      </button>
      <button type="button" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
        —
      </button>

      <span className="sep" />

      <button
        type="button"
        onClick={() => {
          const url = window.prompt("URL") || ""
          if (!url) return
          editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run()
        }}
      >
        Link
      </button>
      <button type="button" onClick={() => editor.chain().focus().unsetLink().run()}>
        Unlink
      </button>

      <span className="sep" />

      <button type="button" onClick={() => editor.chain().focus().setTextAlign("left").run()}>
        ⬅︎
      </button>
      <button type="button" onClick={() => editor.chain().focus().setTextAlign("center").run()}>
        ⬌
      </button>
      <button type="button" onClick={() => editor.chain().focus().setTextAlign("right").run()}>
        ➡︎
      </button>
      <button type="button" onClick={() => editor.chain().focus().unsetTextAlign().run()}>
        ⤺
      </button>

      <span className="sep" />

      <button type="button" onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}>
        Clear
      </button>
    </div>
  )
}

function btn(active: boolean) {
  return `btn btn-xs ${active ? "btn-active" : ""}`
}
