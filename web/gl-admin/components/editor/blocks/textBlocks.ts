import type { Block } from "./index"

export const textBlocks: Block[] = [
  {
    title: "Paragraph",
    description: "Standard text block",
    icon: "📃",
    command: ({ editor }) => {
      editor.chain().focus().setParagraph().run()
    },
    aliases: ["p", "paragraph", "text"],
    slash: true,
    turnInto: true,
  },
  {
    title: "Quote",
    description: "Add a blockquote",
    icon: "💬",
    command: ({ editor }) => {
      editor.chain().focus().setBlockquote().run()
    },
    aliases: ["quote", "blockquote"],
    slash: true,
    turnInto: true,
  },
  {
    title: "Code Block",
    description: "Add a code block with syntax highlighting",
    icon: "💻",
    command: ({ editor }) => {
      editor.chain().focus().setCodeBlock().run()
    },
    aliases: ["code", "codeblock"],
    slash: true,
    turnInto: true,
  },
  {
    title: "Divider",
    description: "Add a horizontal divider",
    icon: "➖",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setHorizontalRule().run()
    },
    aliases: ["hr", "divider", "separator"],
    slash: true,
    turnInto: false,
  },
]
