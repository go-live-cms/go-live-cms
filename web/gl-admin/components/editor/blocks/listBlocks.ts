import type { Block } from "./index"

export const listBlocks: Block[] = [
  {
    title: "Bullet List",
    description: "Create a simple bullet list",
    icon: "•",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleBulletList().run()
    },
    turnInto: ({ editor }) => {
      editor.chain().focus().toggleBulletList().run()
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
    turnInto: ({ editor }) => {
      editor.chain().focus().toggleOrderedList().run()
    },
    aliases: ["ol", "ordered"],
  },
]
