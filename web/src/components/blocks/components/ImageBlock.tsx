import React from "react"
import type { BlockComponentProps, BlockConfig } from "../types"

const ImageBlock: React.FC<BlockComponentProps> = ({ block }) => {
  const attrs = block.attrs as Record<string, unknown>
  const src = (attrs?.src as string) || ""
  const alt = (attrs?.alt as string) || ""
  const title = attrs?.title as string | undefined

  return <img key={block.id} src={src} alt={alt} title={title} />
}

export const imageConfig: BlockConfig = {
  type: "image",
  name: "Image",
  description: "An image with optional alt text and title",
  component: ImageBlock,
  hasChildren: false,
}

export default ImageBlock
