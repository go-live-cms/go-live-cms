import type { Block } from "./index"

export const headingBlocks: Block[] = [
  {
    title: "Heading 1",
    description: "Large section heading",
    icon: "📝",
    command: ({ editor }) => {
      editor.chain().focus().setHeading({ level: 1 }).run()
    },
    aliases: ["h1", "heading1"],
    slash: true,
    turnInto: true,
  },
  {
    title: "Heading 2",
    description: "Medium section heading",
    icon: "📄",
    command: ({ editor }) => {
      editor.chain().focus().setHeading({ level: 2 }).run()
    },
    aliases: ["h2", "heading2"],
    slash: true,
    turnInto: true,
  },
  {
    title: "Heading 3",
    description: "Small section heading",
    icon: "📃",
    command: ({ editor }) => {
      editor.chain().focus().setHeading({ level: 3 }).run()
    },
    aliases: ["h3", "heading3"],
    slash: true,
    turnInto: true,
  },
]
