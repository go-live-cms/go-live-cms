import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import BulletListBlock from "./BulletListBlock"

export const bulletListConfig: BlockConfig = {
  type: "bullet_list",
  name: "Bullet List",
  category: BLOCK_CATEGORIES.TEXT,
  description: "Create an unordered list",
  icon: "•",
  keywords: ["list", "bullet", "ul", "unordered"],
  priority: 60,

  allowedBlocks: ["list_item"],

  component: BulletListBlock,
  hasChildren: true,
}

export default bulletListConfig
