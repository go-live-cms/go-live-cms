import React, { useContext } from "react"
import type { BlockComponentProps } from "../types"
import { HeadingIdsContext, headingLevel } from "../utils/headingAnchors"
import { blockColorClassOf } from "../utils/blockColor"

const HeadingBlock: React.FC<BlockComponentProps> = ({ block, getBlockContent, anchorId }) => {
  const attrs = block.attrs as Record<string, unknown>
  const content = getBlockContent(block)
  const pm = attrs?.pm as { attrs?: { textAlign?: string } } | undefined
  const textAlign = pm?.attrs?.textAlign as "left" | "center" | "right" | undefined
  // The anchor id (#351): a slug of the text, unique within the post (headingAnchors.ts).
  const id = useContext(HeadingIdsContext).get(block.id)

  const style: React.CSSProperties = textAlign ? { textAlign } : {}

  // Levels outside 1-6 render as an h1, as before.
  const Tag = `h${headingLevel(block)}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
  return (
    <Tag key={block.id} id={id ?? anchorId} className={blockColorClassOf(attrs)} style={style}>
      {/* The heading's own id is its slug (#351, the table of contents' links); the block
          link (#356) lands on this empty anchor at its start instead. */}
      {id && anchorId && <span id={anchorId} className="gl-block-anchor" />}
      {content}
    </Tag>
  )
}

export default HeadingBlock
