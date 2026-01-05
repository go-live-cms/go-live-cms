import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import OrderedListBlock from "./OrderedListBlock"

export const orderedListConfig: BlockConfig = {
  type: "ordered_list",
  name: "Numbered List",
  category: BLOCK_CATEGORIES.TEXT,
  description: "Create an ordered list",
  icon: "1.",
  keywords: ["list", "numbered", "ol", "ordered"],
  priority: 70,

  allowedBlocks: ["list_item"],

  component: OrderedListBlock,
  hasChildren: true,
}

export default orderedListConfig
