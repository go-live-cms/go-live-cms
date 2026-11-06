import React from "react"
import { isGroupAlign, isGroupStyle } from "@gl-admin/lib/blocks-spec"
import type { BlockComponentProps } from "../types"

/**
 * A group (#414): its blocks, rendered through `renderBlock` like any child, so every
 * block type works inside one at any depth. Markup the theme styles: `div.group`, plus
 * `is-tinted` (the theme's surface colour) and `alignwide` / `alignfull` (the same width
 * classes as a wide or full image).
 */
const GroupBlock: React.FC<BlockComponentProps> = ({ block, renderBlock, anchorId }) => {
  const attrs = (block.attrs ?? {}) as { style?: unknown; align?: unknown }
  const style = isGroupStyle(attrs.style) ? attrs.style : "none"
  const align = isGroupAlign(attrs.align) ? attrs.align : "content"
  const className = ["group", style === "tinted" && "is-tinted", align === "wide" && "alignwide", align === "full" && "alignfull"]
    .filter(Boolean)
    .join(" ")
  return (
    <div id={anchorId} className={className}>
      {(block.children ?? []).map((childId) => renderBlock(childId))}
    </div>
  )
}

export default GroupBlock