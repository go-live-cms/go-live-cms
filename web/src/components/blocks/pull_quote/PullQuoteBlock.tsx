import React from "react"
import type { BlockComponentProps, PMNode } from "../types"
import { pullQuoteMarkup } from "../utils/textBlockMarkup"

/**
 * A pull quote (#419, "Published · text"): `figure.pullquote > blockquote > p`, and the
 * citation (plain text, the quote's rules: `normalizeCite`) as the `figcaption`. The markup
 * is shared with a pull quote nested in a quote or list item (`textBlockMarkup.tsx`).
 */
const PullQuoteBlock: React.FC<BlockComponentProps> = ({ block, renderContent, anchorId }) => {
  const attrs = (block.attrs ?? {}) as { pm?: { content?: PMNode[] }; text?: unknown; cite?: unknown }
  const content = attrs.pm?.content ? renderContent(attrs.pm.content) : typeof attrs.text === "string" ? attrs.text : null
  return pullQuoteMarkup({ content, cite: attrs.cite, id: anchorId })
}

export default PullQuoteBlock
