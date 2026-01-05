import React from "react"
import type { BlockComponentProps } from "../types"

const HeadingBlock: React.FC<BlockComponentProps> = ({ block, getBlockContent }) => {
  const attrs = block.attrs as Record<string, unknown>
  const level = (attrs?.level as number) || 1
  const content = getBlockContent(block)
  const pm = attrs?.pm as { attrs?: { textAlign?: string } } | undefined
  const textAlign = pm?.attrs?.textAlign as "left" | "center" | "right" | undefined

  const style: React.CSSProperties = textAlign ? { textAlign } : {}

  // Dynamically render heading based on level
  switch (level) {
    case 1:
      return (
        <h1 key={block.id} style={style}>
          {content}
        </h1>
      )
    case 2:
      return (
        <h2 key={block.id} style={style}>
          {content}
        </h2>
      )
    case 3:
      return (
        <h3 key={block.id} style={style}>
          {content}
        </h3>
      )
    case 4:
      return (
        <h4 key={block.id} style={style}>
          {content}
        </h4>
      )
    case 5:
      return (
        <h5 key={block.id} style={style}>
          {content}
        </h5>
      )
    case 6:
      return (
        <h6 key={block.id} style={style}>
          {content}
        </h6>
      )
    default:
      return (
        <h1 key={block.id} style={style}>
          {content}
        </h1>
      )
  }
}

export default HeadingBlock
