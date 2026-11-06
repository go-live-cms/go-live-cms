import React from "react"
import type { BlockComponentProps, PMNode } from "../types"
import { calloutMarkup } from "../utils/textBlockMarkup"

/**
 * A callout (#419, "Published · text"): `div.callout.is-<tone>` with `role="note"`, the
 * tone's icon (decorative, `aria-hidden`), and its paragraphs in `.callout-body`, the first
 * starting with a visually hidden label ("Warning: "), so a screen reader hears the tone
 * and the meaning never rests on colour. A missing or unknown tone renders as info. The
 * markup is shared with a callout nested in a quote or list item (`textBlockMarkup.tsx`).
 */
const CalloutBlock: React.FC<BlockComponentProps> = ({ block, renderContent, anchorId }) => {
  const attrs = (block.attrs ?? {}) as { pm?: { content?: PMNode[] }; text?: unknown; tone?: unknown }
  return calloutMarkup({ tone: attrs.tone, content: attrs.pm?.content, text: attrs.text, renderInline: renderContent, id: anchorId })
}

export default CalloutBlock
