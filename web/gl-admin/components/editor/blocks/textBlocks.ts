import type { SlashCommandItem } from "../SlashCommand"

export const textBlocks = [
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
] as SlashCommandItem[]
