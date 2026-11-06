import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import TableBlock from "./TableBlock"

export const tableConfig: BlockConfig = {
  type: "table",
  name: "Table",
  category: BLOCK_CATEGORIES.TEXT,
  description: "Rows and columns, with an optional header row and caption",
  icon: "▦",
  keywords: ["table", "grid", "rows", "columns"],
  priority: 60,

  component: TableBlock,
  hasChildren: false,
}

export default tableConfig
