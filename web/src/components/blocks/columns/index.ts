import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import ColumnsBlock from "./ColumnsBlock"

export const columnsConfig: BlockConfig = {
  type: "columns",
  name: "Columns",
  category: BLOCK_CATEGORIES.LAYOUT,
  description: "Blocks side by side",
  icon: "| |",
  keywords: ["columns", "layout", "grid", "row"],
  priority: 91,

  component: ColumnsBlock,
  hasChildren: true,
}

export default columnsConfig
