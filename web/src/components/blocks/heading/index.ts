import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES, HEADING_LEVELS } from "../utils/constants"
import HeadingBlock from "./HeadingBlock"

export const headingConfig: BlockConfig = {
  type: "heading",
  name: "Heading",
  category: BLOCK_CATEGORIES.TEXT,
  description: "Heading with configurable levels (H1-H6)",
  icon: "H",
  keywords: ["heading", "title", "h1", "h2", "h3"],
  priority: 20,

  attributes: {
    level: {
      type: "number",
      default: 2,
      enum: HEADING_LEVELS as any,
    },
  },

  supports: {
    align: true,
    anchor: true,
  },

  variations: [
    { name: "h1", title: "Heading 1", attributes: { level: 1 } },
    { name: "h2", title: "Heading 2", attributes: { level: 2 }, isDefault: true },
    { name: "h3", title: "Heading 3", attributes: { level: 3 } },
  ],

  component: HeadingBlock,
  hasChildren: false,
}

export default headingConfig
