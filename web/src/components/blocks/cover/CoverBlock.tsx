import React from "react"
import { isCoverAlign, normalizeCoverOverlay, type CoverAlign } from "@gl-admin/lib/blocks-spec"
import type { BlockComponentProps } from "../types"
import { columnImageSizes } from "../columns/ColumnsBlock"
import { containerImageFor } from "../utils/blockImage"
import ContainerImg from "../utils/ContainerImg"

/**
 * Cover (#427, the canvas's "Published · media & embeds"): `div.cover` with its image behind
 * `div.cover-inner`, which holds the blocks. `--dim` is the overlay as a fraction, `alignwide` and
 * `alignfull` the same width classes as a group. The theme keeps the text readable over it
 * (`themes/README.md`). Left out with its blocks when its image was deleted, or none was chosen.
 */
const CoverBlock: React.FC<BlockComponentProps> = ({ block, doc, renderBlock, anchorId }) => {
  const attrs = (block.attrs ?? {}) as { align?: unknown; overlay?: unknown }
  const align: CoverAlign = isCoverAlign(attrs.align) ? attrs.align : "content"
  const shown = containerImageFor(doc, block as { id: string; type: "cover"; attrs: unknown }, columnImageSizes(1, align))
  if (!shown) return null
  const className = ["cover", align === "wide" && "alignwide", align === "full" && "alignfull"].filter(Boolean).join(" ")
  return (
    <div id={anchorId} className={className} style={{ "--dim": normalizeCoverOverlay(attrs.overlay) / 100 } as React.CSSProperties}>
      {shown.image && <ContainerImg shown={{ ...shown, image: shown.image }} />}
      <div className="cover-inner">{(block.children ?? []).map((childId) => renderBlock(childId))}</div>
    </div>
  )
}

export default CoverBlock
