import React from "react"
import type { BlockComponentProps, PMNode } from "../types"

const BlockquoteBlock: React.FC<BlockComponentProps> = ({ block, renderContent, getBlockContent }) => {
  const attrs = block.attrs as Record<string, unknown>
  const pm = attrs?.pm as { content?: PMNode[] } | undefined

  // Blockquote may have nested paragraph content
  const content = pm?.content ? renderContent(pm.content) : getBlockContent(block)

  return <blockquote key={block.id}>{content}</blockquote>
}

export default BlockquoteBlock
