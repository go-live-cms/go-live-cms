import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import DividerBlock from "./DividerBlock"

export const dividerConfig: BlockConfig = {
  type: "divider",
  name: "Divider",
  category: BLOCK_CATEGORIES.DESIGN,
  description: "Visual separator between content sections",
  icon: "—",
  keywords: ["divider", "separator", "hr", "line"],
  priority: 50,

  component: DividerBlock,
  hasChildren: false,
}

export default dividerConfig
