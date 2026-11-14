import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import SearchBlock from "./SearchBlock"
import { SITE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

export const searchConfig: BlockConfig = {
  type: "search",
  version: SITE_BLOCK_VERSION,
  name: "Search",
  category: BLOCK_CATEGORIES.WIDGETS,
  description: "A search box that opens the results page (templates only)",
  icon: "⌕",
  keywords: ["search", "find", "form"],
  component: SearchBlock,
  hasChildren: false,
}

export default searchConfig