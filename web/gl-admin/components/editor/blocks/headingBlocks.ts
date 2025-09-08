import type { SlashCommandItem } from "../SlashCommand"

export const headingBlocks = [
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
] as SlashCommandItem[]
