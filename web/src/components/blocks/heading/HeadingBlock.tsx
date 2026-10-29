import React, { useContext } from "react"
import type { BlockComponentProps } from "../types"
import { HeadingIdsContext } from "../utils/headingAnchors"

const HeadingBlock: React.FC<BlockComponentProps> = ({ block, getBlockContent }) => {
  const attrs = block.attrs as Record<string, unknown>
  const level = (attrs?.level as number) || 1
  const content = getBlockContent(block)
  const pm = attrs?.pm as { attrs?: { textAlign?: string } } | undefined
  const textAlign = pm?.attrs?.textAlign as "left" | "center" | "right" | undefined
  // The anchor id (#351): a slug of the text, unique within the post (headingAnchors.ts).
  const id = useContext(HeadingIdsContext).get(block.id)

  const style: React.CSSProperties = textAlign ? { textAlign } : {}

  // Levels outside 1-6 render as an h1, as before.
  const Tag = (Number.isInteger(level) && level >= 1 && level <= 6 ? `h${level}` : "h1") as "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
  return (
    <Tag key={block.id} id={id} style={style}>
      {content}
    </Tag>
  )
}

export default HeadingBlock
