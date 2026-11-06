import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import CalloutBlock from "./CalloutBlock"

export const calloutConfig: BlockConfig = {
  type: "callout",
  name: "Callout",
  category: BLOCK_CATEGORIES.TEXT,
  description: "A note set apart from the text: info, success, warning or danger",
  icon: "i",
  keywords: ["callout", "note", "info", "warning", "tip"],
  priority: 35,

  attributes: {
    // info | success | warning | danger (Block Spec CALLOUT_TONES); absent: info.
    tone: {
      type: "string",
      default: "info",
    },
  },

  component: CalloutBlock,
  hasChildren: false,
}

export default calloutConfig
