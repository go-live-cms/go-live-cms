import type { Block } from "./index"

export const listBlocks: Block[] = [
  {
    title: "Bullet List",
    description: "Create a simple bullet list",
    icon: "•",
    command: ({ editor }) => {
      editor.chain().focus().toggleBulletList().run()
    },
    aliases: ["ul", "list"],
    slash: true,
    turnInto: true,
  },
  {
    title: "Numbered List",
    description: "Create a numbered list",
    icon: "1.",
    command: ({ editor }) => {
      editor.chain().focus().toggleOrderedList().run()
    },
    aliases: ["ol", "ordered"],
    slash: true,
    turnInto: true,
  },
]
