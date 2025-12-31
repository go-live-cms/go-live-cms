import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import ImageBlock from "./ImageBlock"

export const imageConfig: BlockConfig = {
  type: "image",
  name: "Image",
  category: BLOCK_CATEGORIES.MEDIA,
  description: "Display an image from the media library",
  icon: "🖼️",
  keywords: ["image", "photo", "picture", "img"],
  priority: 10,

  attributes: {
    src: {
      type: "string",
      required: true,
    },
    alt: {
      type: "string",
      default: "",
    },
    title: {
      type: "string",
    },
    mediaId: {
      type: "number",
    },
  },

  supports: {
    align: true,
  },

  component: ImageBlock,
  hasChildren: false,
}

export default imageConfig
