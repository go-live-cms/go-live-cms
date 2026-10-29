import React, { useContext } from "react"
import { captionRuns, isImageAlign } from "@gl-admin/lib/blocks-spec"
import type { BlockComponentProps } from "../types"
import { renderContent } from "../utils/contentRenderer"
import { blockMediaFor, ImageSizesContext, isFirstImageBlock, responsiveImageAttrs } from "../utils/responsiveImage"

const ImageBlock: React.FC<BlockComponentProps> = ({ block, doc }) => {
  const attrs = block.attrs as Record<string, unknown>
  const alt = (attrs?.alt as string) || ""
  const title = attrs?.title as string | undefined
  const sizes = useContext(ImageSizesContext)

  // srcset/sizes from the media's variants and object-position from its
  // focal point, when the API attached them (#255); src is always the
  // block's own (sanitized) URL.
  const image = responsiveImageAttrs(attrs?.src as string | undefined, blockMediaFor(doc, attrs?.mediaId), sizes)
  // The first image is usually above the fold (and often the LCP element):
  // don't make it wait for lazy loading.
  const eager = isFirstImageBlock(doc, block.id)

  const img = (
    <img
      key={block.id}
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

  // Caption and width (#346). An image with neither stays a bare <img>, as before.
  // Only text runs and caption marks (the API sanitizer strips the rest too).
  const caption = captionRuns(attrs?.caption)
  const align = isImageAlign(attrs?.align) && attrs.align !== "inline" ? attrs.align : null
  if (caption.length === 0 && !align) return img

  return (
    <figure key={block.id} className={align ? `align-${align}` : undefined}>
      {img}
      {caption.length > 0 && <figcaption>{renderContent(caption)}</figcaption>}
    </figure>
  )
}

export default ImageBlock
