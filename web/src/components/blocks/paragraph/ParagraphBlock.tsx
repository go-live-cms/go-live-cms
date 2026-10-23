import React from "react"
import type { BlockComponentProps } from "../types"
import { isBlankParagraph } from "../utils/contentRenderer"

const ParagraphBlock: React.FC<BlockComponentProps> = ({ block, getBlockContent }) => {
  const content = getBlockContent(block)
  const attrs = block.attrs as Record<string, unknown>
  const pm = attrs?.pm as { attrs?: { textAlign?: string } } | undefined
  const textAlign = pm?.attrs?.textAlign as "left" | "center" | "right" | undefined

  const style: React.CSSProperties = textAlign ? { textAlign } : {}

  // A blank paragraph (no content, or only whitespace) is a blank line the author put
  // there on purpose (the editor shows it as a full line via ProseMirror's trailing
  // <br>). Render it the same way: returning null, or a <p> with nothing visible in it
  // (zero height), erased that spacing (#306). Blank paragraphs at the very end of the
  // document are trimmed by BlockRenderer instead.
  return (
    <p key={block.id} style={style}>
      {isBlankParagraph(block) ? <br /> : content}
    </p>
  )
}

export default ParagraphBlock
