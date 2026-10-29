import React from "react"
import { normalizeCite } from "@gl-admin/lib/blocks-spec"
import type { BlockComponentProps, PMNode } from "../types"

const BlockquoteBlock: React.FC<BlockComponentProps> = ({ block, renderContent, getBlockContent }) => {
  const attrs = block.attrs as Record<string, unknown>
  const pm = attrs?.pm as { content?: PMNode[] } | undefined

  // Blockquote may have nested paragraph content
  const content = pm?.content ? renderContent(pm.content) : getBlockContent(block)
  // The attribution (#346), plain text.
  const cite = normalizeCite(attrs?.cite)

  return (
    <blockquote key={block.id}>
      {content}
      {cite && <cite>{cite}</cite>}
    </blockquote>
  )
}

export default BlockquoteBlock
