import React from "react"
import type { BlockComponentProps } from "../types"

/**
 * Custom HTML (#428, "Published · layout"): the one place the public site outputs raw HTML.
 * It outputs `attrs.html` and nothing else: the markup the API sanitized on publish and
 * copied into the published document. Nothing else reads the working table, and a block
 * whose snippet didn't belong to the post has no `html`, so it renders nothing.
 */
const HtmlBlock: React.FC<BlockComponentProps> = ({ block, anchorId }) => {
  const html = (block.attrs as { html?: unknown }).html
  if (typeof html !== "string" || html === "") return null
  return <div id={anchorId} className="html-block" dangerouslySetInnerHTML={{ __html: html }} />
}

export default HtmlBlock
