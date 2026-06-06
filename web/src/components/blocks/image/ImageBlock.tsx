import React from "react"
import type { BlockComponentProps } from "../types"
import { safeImageSrc } from "../utils/safeUrl"

const ImageBlock: React.FC<BlockComponentProps> = ({ block }) => {
  const attrs = block.attrs as Record<string, unknown>
  const src = safeImageSrc(attrs?.src as string | undefined)
  const alt = (attrs?.alt as string) || ""
  const title = attrs?.title as string | undefined

  return <img key={block.id} src={src} alt={alt} title={title} />
}

export default ImageBlock
