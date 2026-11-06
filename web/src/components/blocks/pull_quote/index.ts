import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import PullQuoteBlock from "./PullQuoteBlock"

export const pullQuoteConfig: BlockConfig = {
  type: "pull_quote",
  name: "Pull quote",
  category: BLOCK_CATEGORIES.TEXT,
  description: "A line from the post, set large",
  icon: "❞",
  keywords: ["pull quote", "quote", "highlight"],
  priority: 31,

  attributes: {
    // Plain-text attribution, rendered as <figcaption>.
    cite: {
      type: "string",
    },
  },

  component: PullQuoteBlock,
  hasChildren: false,
}

export default pullQuoteConfig
