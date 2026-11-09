import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import ButtonsBlock from "./ButtonsBlock"

export const buttonsConfig: BlockConfig = {
  type: "buttons",
  name: "Buttons",
  category: BLOCK_CATEGORIES.LAYOUT,
  description: "One or more links styled as buttons",
  icon: "[btn]",
  keywords: ["button", "cta", "link"],
  priority: 92,

  component: ButtonsBlock,
}

export default buttonsConfig
