import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import ColumnBlock from "./ColumnBlock"

export const columnConfig: BlockConfig = {
  type: "column",
  name: "Column",
  category: BLOCK_CATEGORIES.LAYOUT,
  description: "One column of a columns block",
  icon: "|",
  // Only inside a columns block (the nesting table).
  isPrivate: true,

  component: ColumnBlock,
  hasChildren: true,
}

export default columnConfig
