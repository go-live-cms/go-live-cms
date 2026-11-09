import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import SpacerBlock from "./SpacerBlock"

export const spacerConfig: BlockConfig = {
  type: "spacer",
  name: "Spacer",
  category: BLOCK_CATEGORIES.LAYOUT,
  description: "Empty space in steps of the theme's spacing scale",
  icon: "↕",
  keywords: ["space", "gap", "margin"],
  priority: 93,

  component: SpacerBlock,
}

export default spacerConfig
