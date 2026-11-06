import React from "react"
import { CALLOUT_TONE_ICONS, CALLOUT_TONE_LABELS, normalizeCalloutTone } from "@gl-admin/lib/blocks-spec"
import type { BlockComponentProps, PMNode } from "../types"
import { renderContent } from "../utils/contentRenderer"

/**
 * A callout (#419, "Published · text"): `div.callout.is-<tone>` with `role="note"`, the
 * tone's icon (decorative, `aria-hidden`), and its paragraphs in `.callout-body`, the first
 * starting with a visually hidden label ("Warning: "), so a screen reader hears the tone
 * and the meaning never rests on colour. A missing or unknown tone renders as info.
 */
const CalloutBlock: React.FC<BlockComponentProps> = ({ block, anchorId }) => {
  const attrs = (block.attrs ?? {}) as { pm?: { content?: PMNode[] }; text?: unknown; tone?: unknown }
  const tone = normalizeCalloutTone(attrs.tone)
  const label = <span className="sr-only">{`${CALLOUT_TONE_LABELS[tone]}: `}</span>
  const paragraphs = (attrs.pm?.content ?? []).filter((node) => node?.type === "paragraph")

  return (
    <div id={anchorId} className={`callout is-${tone}`} role="note">
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={CALLOUT_TONE_ICONS[tone]} />
      </svg>
      <div className="callout-body">
        {paragraphs.length > 0 ? (
          paragraphs.map((paragraph, index) => (
            <p key={index}>
              {index === 0 && label}
              {renderContent(paragraph.content)}
            </p>
          ))
        ) : (
          <p>
            {label}
            {typeof attrs.text === "string" ? attrs.text : null}
          </p>
        )}
      </div>
    </div>
  )
}

export default CalloutBlock
