import React from "react"
import type { BlockComponentProps } from "../types"
import { blockMediaFor, responsiveImageAttrs } from "../utils/responsiveImage"

const ImageBlock: React.FC<BlockComponentProps> = ({ block, doc }) => {
  const attrs = block.attrs as Record<string, unknown>
  const alt = (attrs?.alt as string) || ""
  const title = attrs?.title as string | undefined

  // srcset/sizes from the media's variants and object-position from its
  // focal point, when the API attached them (#255); src is always the
  // block's own (sanitized) URL.
  const image = responsiveImageAttrs(attrs?.src as string | undefined, blockMediaFor(doc, attrs?.mediaId))

  return (
    <img
      key={block.id}
      src={image.src}
      srcSet={image.srcSet}
      sizes={image.sizes}
      width={image.width}
      height={image.height}
      style={image.objectPosition ? { objectPosition: image.objectPosition } : undefined}
      loading="lazy"
      decoding="async"
      alt={alt}
      title={title}
    />
  )
}

export default ImageBlock
