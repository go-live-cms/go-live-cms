import React from "react"
import type { BlockComponentProps, BlockConfig } from "../types"

const ParagraphBlock: React.FC<BlockComponentProps> = ({ block, getBlockContent }) => {
  const content = getBlockContent(block)
  return content ? <p key={block.id}>{content}</p> : null
}

export const paragraphConfig: BlockConfig = {
  type: "paragraph",
  name: "Paragraph",
  description: "A standard text paragraph with inline formatting support",
  component: ParagraphBlock,
  hasChildren: false,
}

export default ParagraphBlock
