import React from "react"
import { columnsLayoutFor, columnWidths, isGroupAlign, type GroupAlign } from "@gl-admin/lib/blocks-spec"
import type { BlockComponentProps } from "../types"
import { ImageSizesContext } from "../utils/responsiveImage"

// How wide a row of columns can get, by its width setting (the default theme's content and
// wide widths; a wider theme only costs a slightly larger image).
const ROW_WIDTH: Record<Exclude<GroupAlign, "full">, number> = { content: 680, wide: 960 }

/**
 * `sizes` for an image in a column (#426): the column's share of the row above the width
 * where columns stack (`theme.css`, 640px), the whole screen below it. Erring wide only
 * costs a larger download; a narrower guess would pick a blurry variant.
 */
export function columnImageSizes(share: number, align: GroupAlign): string {
  const percent = Math.round(share * 100)
  if (align === "full") return `(max-width: 640px) 100vw, ${percent}vw`
  return `(max-width: 640px) 100vw, ${Math.ceil(ROW_WIDTH[align] * share)}px`
}

/**
 * Columns (#426): its columns side by side, stacking in order on phones (the theme's job:
 * `div.columns` is a grid, `is-3-columns` / `is-4-columns` when it isn't two). Markup the
 * theme styles: `is-33-67` / `is-67-33` for the two-column splits, `alignwide` / `alignfull`
 * as on a group.
 *
 * Each column gets its own `ImageSizesContext`, so an image in it says how wide it really is.
 */
const ColumnsBlock: React.FC<BlockComponentProps> = ({ block, renderBlock, anchorId }) => {
  const attrs = (block.attrs ?? {}) as { layout?: unknown; align?: unknown }
  const children = block.children ?? []
  const layout = columnsLayoutFor(attrs.layout, children.length)
  const align: GroupAlign = isGroupAlign(attrs.align) ? attrs.align : "content"
  const widths = columnWidths(layout, children.length)
  const className = [
    "columns",
    children.length > 2 && `is-${children.length}-columns`,
    layout === "33-67" && "is-33-67",
    layout === "67-33" && "is-67-33",
    align === "wide" && "alignwide",
    align === "full" && "alignfull",
  ]
    .filter(Boolean)
    .join(" ")
  return (
    <div id={anchorId} className={className}>
      {children.map((childId, index) => (
        <ImageSizesContext.Provider key={childId} value={columnImageSizes(widths[index], align)}>
          {renderBlock(childId)}
        </ImageSizesContext.Provider>
      ))}
    </div>
  )
}

export default ColumnsBlock
