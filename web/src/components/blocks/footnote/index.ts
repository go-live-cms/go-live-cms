import React from "react"
import type { BlockComponentProps, BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"

// The public list renders its notes itself, in number order (`footnotes/`). This is for what
// renders one block at a time: History's comparison (#355).
const FootnoteBlock: React.FC<BlockComponentProps> = ({ block, getBlockContent }) => React.createElement("p", null, getBlockContent(block))

export const footnoteConfig: BlockConfig = {
  type: "footnote",
  name: "Footnote",
  category: BLOCK_CATEGORIES.TEXT,
  description: "One note of the Footnotes list",
  icon: "¹",
  isPrivate: true,

  component: FootnoteBlock,
  hasChildren: false,
}

export default footnoteConfig
