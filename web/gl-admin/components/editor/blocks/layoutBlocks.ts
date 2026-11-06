import type { Block } from "./index"

// Layout blocks (#352). Group is the first container (#414); columns follow (#426).
// #415 moves these entries into the block catalog (`catalog.ts`).
export const layoutBlocks: Block[] = [
  {
    title: "Group",
    description: "Keep blocks together, optionally on a tint",
    icon: "[ ]",
    group: "layout",
    command: ({ editor, range }) => {
      // The current (now empty) line becomes the group's first block, with the cursor in it.
      editor.chain().focus().deleteRange(range).setGroup().run()
    },
    aliases: ["group", "section", "container", "box", "tint"],
  },
]