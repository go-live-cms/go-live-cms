import React from "react"
import { normalizeCite } from "@gl-admin/lib/blocks-spec"
import type { BlockComponentProps, PMNode } from "../types"

/**
 * A pull quote (#419, "Published · text"): `figure.pullquote > blockquote > p`, and the
 * citation (plain text, the quote's rules: `normalizeCite`) as the `figcaption`.
 */
const PullQuoteBlock: React.FC<BlockComponentProps> = ({ block, renderContent, anchorId }) => {
  const attrs = (block.attrs ?? {}) as { pm?: { content?: PMNode[] }; text?: unknown; cite?: unknown }
  const content = attrs.pm?.content ? renderContent(attrs.pm.content) : typeof attrs.text === "string" ? attrs.text : null
  const cite = normalizeCite(attrs.cite)

  return (
    <figure id={anchorId} className="pullquote">
      <blockquote>
        <p>{content}</p>
      </blockquote>
      {cite && <figcaption>{cite}</figcaption>}
    </figure>
  )
}

export default PullQuoteBlock
