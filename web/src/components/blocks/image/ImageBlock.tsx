import React, { useContext } from "react"
import { captionRuns, isImageAlign, isMediaMissing } from "@gl-admin/lib/blocks-spec"
import type { BlockComponentProps } from "../types"
import { renderContent } from "../utils/contentRenderer"
import { blockMediaFor, ImageInGalleryContext, ImageSizesContext, isFirstImageBlock, responsiveImageAttrs } from "../utils/responsiveImage"

const ImageBlock: React.FC<BlockComponentProps> = ({ block, doc, anchorId }) => {
  const attrs = block.attrs as Record<string, unknown>
  const sizes = useContext(ImageSizesContext)
  const inGallery = useContext(ImageInGalleryContext)
  // The image was deleted from Media (#423, the API's `media_missing`): left out, caption
  // and all, rather than a broken image. A failed lookup is not that: the image then
  // renders from its own src.
  if (isMediaMissing(doc, attrs?.mediaId)) return null
  const title = attrs?.title as string | undefined
  const media = blockMediaFor(doc, attrs?.mediaId)
  // A decorative image (#325) is skipped by screen readers whatever alt text the block
  // was inserted with.
  const alt = media?.decorative ? "" : (attrs?.alt as string) || ""

  // srcset/sizes from the media's variants and object-position from its
  // focal point, when the API attached them (#255); src is always the
  // block's own (sanitized) URL.
  const image = responsiveImageAttrs(attrs?.src as string | undefined, media, sizes)
  // The first image is usually above the fold (and often the LCP element):
  // don't make it wait for lazy loading.
  const eager = isFirstImageBlock(doc, block.id)

  // Caption and width (#346). An image with neither stays a bare <img>, as before, and then
  // carries the block anchor (#356) itself. Only text runs and caption marks (the API
  // sanitizer strips the rest too).
  const caption = captionRuns(attrs?.caption)
  const align = !inGallery && isImageAlign(attrs?.align) && attrs.align !== "inline" ? attrs.align : null
  const bare = caption.length === 0 && !align

  const img = (
    <img
      key={block.id}
      id={bare ? anchorId : undefined}
      src={image.src}
      srcSet={image.srcSet}
      sizes={image.sizes}
      width={image.width}
      height={image.height}
      style={image.objectPosition ? { objectPosition: image.objectPosition } : undefined}
      loading={eager ? undefined : "lazy"}
      decoding="async"
      alt={alt}
      title={title}
    />
  )

  if (bare) return img

  return (
    <figure key={block.id} id={anchorId} className={align ? `align-${align}` : undefined}>
      {img}
      {caption.length > 0 && <figcaption>{renderContent(caption)}</figcaption>}
    </figure>
  )
}

export default ImageBlock
