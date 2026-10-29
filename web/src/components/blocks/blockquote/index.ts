import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import BlockquoteBlock from "./BlockquoteBlock"
import { BLOCKQUOTE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

export const blockquoteConfig: BlockConfig = {
  type: "blockquote",
  // v2 (#346): cite.
  version: BLOCKQUOTE_BLOCK_VERSION,
  name: "Quote",
  category: BLOCK_CATEGORIES.TEXT,
  description: "Display a quote or citation",
  icon: "❝",
  keywords: ["quote", "citation", "blockquote"],
  priority: 30,

  attributes: {
    // Plain-text attribution, rendered as <cite>.
    cite: {
      type: "string",
    },
  },

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
