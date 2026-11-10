import React from "react"
import type { BlockComponentProps } from "../types"
import { columnImageSizes } from "../columns/ColumnsBlock"
import { containerImageFor } from "../utils/blockImage"
import ContainerImg from "../utils/ContainerImg"
import { ImageSizesContext } from "../utils/responsiveImage"

/**
 * Media & text (#427, the canvas's "Published · media & embeds"): `div.media-text` holding
 * `figure.media-text-media` and `div.media-text-body`, the media first in the markup, so it
 * sits above the text on phones whatever the wide layout. `is-media-right` moves it to the
 * right on wide screens. Left out with its blocks when its image was deleted, or none was chosen.
 */
const MediaTextBlock: React.FC<BlockComponentProps> = ({ block, doc, renderBlock, anchorId }) => {
  const sizes = columnImageSizes(0.5, "content")
  const shown = containerImageFor(doc, block as { id: string; type: "media_text"; attrs: unknown }, sizes)
  if (!shown) return null
  const right = (block.attrs as { position?: unknown } | undefined)?.position === "right"
  const className = ["media-text", right && "is-media-right", !shown.image && "is-no-media"].filter(Boolean).join(" ")
  return (
    <div id={anchorId} className={className}>
      {shown.image && (
        <figure className="media-text-media">
          <ContainerImg shown={{ ...shown, image: shown.image }} />
        </figure>
      )}
      <ImageSizesContext.Provider value={sizes}>
        <div className="media-text-body">{(block.children ?? []).map((childId) => renderBlock(childId))}</div>
      </ImageSizesContext.Provider>
    </div>
  )
}

export default MediaTextBlock
