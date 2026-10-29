import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import ImageBlock from "./ImageBlock"
import { IMAGE_ALIGNS, IMAGE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

export const imageConfig: BlockConfig = {
  type: "image",
  // v2 (#346): caption and align.
  version: IMAGE_BLOCK_VERSION,
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
    // Text runs with bold, italic and link marks (Block Spec `CaptionText[]`).
    caption: {
      type: "array",
    },
    align: {
      type: "string",
      default: "inline",
      enum: [...IMAGE_ALIGNS],
    },
  },

  supports: {
    align: true,
  },

  component: ImageBlock,
  hasChildren: false,
}

export default imageConfig
