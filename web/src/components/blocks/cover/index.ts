import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import CoverBlock from "./CoverBlock"

export const coverConfig: BlockConfig = {
  type: "cover",
  name: "Cover",
  category: BLOCK_CATEGORIES.MEDIA,
  description: "An image with blocks on top",
  icon: "▣",
  keywords: ["cover", "hero", "banner", "background"],
  priority: 95,

  component: CoverBlock,
  hasChildren: true,
}

export default coverConfig
