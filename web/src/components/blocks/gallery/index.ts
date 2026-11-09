import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import GalleryBlock from "./GalleryBlock"

export const galleryConfig: BlockConfig = {
  type: "gallery",
  name: "Gallery",
  category: BLOCK_CATEGORIES.MEDIA,
  description: "Images in a grid, each with its own alt text and caption",
  icon: "▦",
  keywords: ["gallery", "images", "photos", "grid", "album"],
  priority: 90,

  component: GalleryBlock,
  hasChildren: true,
}

export default galleryConfig
