import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import DetailsBlock from "./DetailsBlock"

export const detailsConfig: BlockConfig = {
  type: "details",
  name: "Details",
  category: BLOCK_CATEGORIES.TEXT,
  description: "A summary readers open to see more",
  icon: "▸",
  keywords: ["details", "toggle", "accordion", "faq", "summary"],
  priority: 90,

  component: DetailsBlock,
  hasChildren: true,
}

export default detailsConfig
