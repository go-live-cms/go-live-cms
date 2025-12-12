import React from "react"
import type { BlockComponentProps, BlockConfig } from "../types"

const ParagraphBlock: React.FC<BlockComponentProps> = ({ block, getBlockContent }) => {
  const content = getBlockContent(block)
  const attrs = block.attrs as Record<string, unknown>
  const pm = attrs?.pm as { attrs?: { textAlign?: string } } | undefined
  const textAlign = pm?.attrs?.textAlign as "left" | "center" | "right" | undefined

  const style: React.CSSProperties = textAlign ? { textAlign } : {}

  return content ? (
    <p key={block.id} style={style}>
      {content}
    </p>
  ) : null
}

export const paragraphConfig: BlockConfig = {
  type: "paragraph",
  name: "Paragraph",
  description: "A standard text paragraph with inline formatting support",
  component: ParagraphBlock,
  hasChildren: false,
}

export default ParagraphBlock
