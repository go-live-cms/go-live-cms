import type { SlashCommandItem } from "../SlashCommand"

export const listBlocks = [
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
] as SlashCommandItem[]
