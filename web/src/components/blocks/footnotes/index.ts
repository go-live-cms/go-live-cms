import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import FootnotesBlock from "./FootnotesBlock"

export const footnotesConfig: BlockConfig = {
  type: "footnotes",
  name: "Footnotes",
  category: BLOCK_CATEGORIES.TEXT,
  description: "The notes the post's references point at",
  icon: "¹",
  // Inserted through a reference, never on its own.
  isPrivate: true,

  component: FootnotesBlock,
  hasChildren: true,
}

export default footnotesConfig
