import React from "react"
import { captionRuns, isMediaMissing, normalizeGalleryColumns } from "@gl-admin/lib/blocks-spec"
import type { BlockComponentProps } from "../types"
import { ImageInGalleryContext, ImageSizesContext } from "../utils/responsiveImage"

/**
 * `sizes` for a gallery's images (#424): two columns on a phone (the default theme's 640px
 * break), else the content column's share. Wrong only by the gap between tiles, which only
 * costs a slightly larger download.
 */
export function gallerySizes(columns: number): string {
  const share = Math.round(100 / columns)
  return `(max-width: 640px) 50vw, (max-width: 1000px) ${share}vw, ${Math.round(1000 / columns)}px`
}

/**
 * Gallery (#424, the canvas's "Published · media & embeds"): `figure.gallery-block` with the
 * images in `ul.gallery` (the theme's grid, `--cols` for the column count, two columns on a
 * phone) and the caption under them. Each image renders through `renderBlock`, the ordinary
 * image block: its own alt, its own caption, its focal point. Left out with its caption
 * when it has no image to show: an empty gallery, or every image's media deleted.
 */
const GalleryBlock: React.FC<BlockComponentProps> = ({ block, doc, renderBlock, renderContent, anchorId }) => {
  const attrs = (block.attrs ?? {}) as { columns?: unknown; caption?: unknown }
  const images = (block.children ?? []).filter((id) => {
    const child = doc.blocks[id] as { type?: string; attrs?: { src?: unknown; mediaId?: unknown } } | undefined
    return child?.type === "image" && !!child.attrs?.src && !isMediaMissing(doc, child.attrs.mediaId)
  })
  if (images.length === 0) return null
  const columns = normalizeGalleryColumns(attrs.columns)
  const caption = captionRuns(attrs.caption)
  return (
    <figure id={anchorId} className="gallery-block">
      <ImageInGalleryContext.Provider value={true}>
        <ImageSizesContext.Provider value={gallerySizes(columns)}>
          <ul className="gallery" style={{ "--cols": columns } as React.CSSProperties}>
            {images.map((id) => (
              <li key={id}>{renderBlock(id)}</li>
            ))}
          </ul>
        </ImageSizesContext.Provider>
      </ImageInGalleryContext.Provider>
      {caption.length > 0 && <figcaption>{renderContent(caption)}</figcaption>}
    </figure>
  )
}

export default GalleryBlock
