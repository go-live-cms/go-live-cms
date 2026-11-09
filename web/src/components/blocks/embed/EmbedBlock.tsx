import React from "react"
import { captionRuns, EMBED_PROVIDER_SPECS, embedFrameLabel, embedIconOf, embedTargetOf, normalizeEmbedTitle } from "@gl-admin/lib/blocks-spec"
import type { BlockComponentProps } from "../types"
import { renderContent } from "../utils/contentRenderer"

/**
 * An embed (#425, the canvas's "Published · media & embeds"): a placeholder until the reader
 * asks for the player, so opening the post sends nothing to another site. There is no iframe,
 * image or provider address in this markup, only which item it is; `/gl-embeds.js` builds the
 * player on click and moves focus into it (`BlockRenderer` adds the script when a post has an
 * embed).
 *
 * `figure.embed-block > div.embed-frame(.is-card|.is-compact)` with `.embed-provider`,
 * `.embed-title`, the Load button and `.embed-note`, then `figcaption`.
 *
 * Renders nothing without a valid provider and ref: an empty block, or one whose provider
 * the site no longer allows (the API empties those before serving the post).
 */
const EmbedBlock: React.FC<BlockComponentProps> = ({ block, anchorId }) => {
  const attrs = block.attrs as Record<string, unknown>
  const target = embedTargetOf(attrs)
  if (!target) return null

  const spec = EMBED_PROVIDER_SPECS[target.provider]
  const stored = normalizeEmbedTitle(attrs.title)
  const title = stored ?? spec.kind
  const caption = captionRuns(attrs.caption)
  const className = ["embed-frame", spec.card && "is-card", spec.compact && "is-compact"].filter(Boolean).join(" ")

  return (
    <figure id={anchorId} className="embed-block">
      <div className={className} data-embed-provider={target.provider} data-embed-ref={target.ref} data-embed-label={embedFrameLabel(target.provider, stored)}>
        <span className="embed-provider">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={embedIconOf(target.provider)} />
          </svg>
          {spec.kind}
        </span>
        <p className="embed-title">{title}</p>
        <button type="button" className={`btn ${spec.card ? "btn-secondary" : "btn-primary"}`} data-embed-load="" aria-label={`${spec.load}: ${title}`}>
          {spec.load}
        </button>
        <span className="embed-note">Loading it connects to {spec.host}</span>
      </div>
      {caption.length > 0 && <figcaption>{renderContent(caption)}</figcaption>}
    </figure>
  )
}

export default EmbedBlock
