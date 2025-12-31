import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import BlockquoteBlock from "./BlockquoteBlock"

export const blockquoteConfig: BlockConfig = {
  type: "blockquote",
  name: "Quote",
  category: BLOCK_CATEGORIES.TEXT,
  description: "Display a quote or citation",
  icon: "❝",
  keywords: ["quote", "citation", "blockquote"],
  priority: 30,

  supports: {
    align: true,
  },

  component: BlockquoteBlock,
  hasChildren: false,

  example: {
    attributes: {
      text: "To be or not to be, that is the question.",
    },
  },
}

export default blockquoteConfig
