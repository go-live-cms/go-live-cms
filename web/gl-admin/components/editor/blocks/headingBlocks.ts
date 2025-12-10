import type { Block } from "./index"

export const headingBlocks: Block[] = [
  {
    title: "Heading",
    description: "Section heading (use toolbar to change level)",
    icon: "📝",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setHeading({ level: 2 }).run()
    },
    turnInto: ({ editor }) => {
      editor.chain().focus().setHeading({ level: 2 }).run()
    },
    aliases: ["h", "heading", "h1", "h2", "h3", "h4", "h5", "h6"],
  },
]
