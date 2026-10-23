import React from "react"
import type { BlockComponentProps } from "../types"

const isEmptyContent = (content: React.ReactNode): boolean =>
  content == null || content === false || content === "" || (Array.isArray(content) && content.every(isEmptyContent))

const ParagraphBlock: React.FC<BlockComponentProps> = ({ block, getBlockContent }) => {
  const content = getBlockContent(block)
  const attrs = block.attrs as Record<string, unknown>
  const pm = attrs?.pm as { attrs?: { textAlign?: string } } | undefined
  const textAlign = pm?.attrs?.textAlign as "left" | "center" | "right" | undefined

  const style: React.CSSProperties = textAlign ? { textAlign } : {}

  // An empty paragraph is a blank line the author put there on purpose (the editor
  // shows it as a full line via ProseMirror's trailing <br>). Render it the same way:
  // returning null, or an empty <p></p> (zero height), erased that spacing (#306).
  return (
    <p key={block.id} style={style}>
      {isEmptyContent(content) ? <br /> : content}
    </p>
  )
}

export default ParagraphBlock
