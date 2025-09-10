import type { Block } from "./index"

export const textBlocks: Block[] = [
  {
    title: "Paragraph",
    description: "Standard text block",
    icon: "📃",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setParagraph().run()
    },
    turnInto: ({ editor }) => {
      editor.chain().focus().setParagraph().run()
    },
    aliases: ["p", "paragraph", "text"],
  },
  {
    title: "Quote",
    description: "Add a blockquote",
    icon: "💬",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setBlockquote().run()
    },
    turnInto: ({ editor }) => {
      editor.chain().focus().setBlockquote().run()
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
    turnInto: ({ editor }) => {
      editor.chain().focus().setCodeBlock().run()
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
]
