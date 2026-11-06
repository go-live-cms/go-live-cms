import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import GroupBlock from "./GroupBlock"

export const groupConfig: BlockConfig = {
  type: "group",
  name: "Group",
  category: BLOCK_CATEGORIES.LAYOUT,
  description: "Keep blocks together, optionally on a tint",
  icon: "[ ]",
  keywords: ["group", "section", "container", "box"],
  priority: 90,

  component: GroupBlock,
  hasChildren: true,
}

export default groupConfig