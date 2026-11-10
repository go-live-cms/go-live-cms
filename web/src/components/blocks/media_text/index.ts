import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import MediaTextBlock from "./MediaTextBlock"

export const mediaTextConfig: BlockConfig = {
  type: "media_text",
  name: "Media & text",
  category: BLOCK_CATEGORIES.MEDIA,
  description: "An image beside other blocks, stacked on phones",
  icon: "◧",
  keywords: ["media", "image and text", "side by side"],
  priority: 96,

  component: MediaTextBlock,
  hasChildren: true,
}

export default mediaTextConfig
