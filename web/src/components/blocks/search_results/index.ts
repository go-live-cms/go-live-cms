import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import { SearchResultsBlock } from "../utils/siteBlocksIV"
import { SITE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

// #498: a site block (utils/siteBlocksIV.tsx), rendered only inside a block template.
export const searchResultsConfig: BlockConfig = {
  type: "search_results",
  version: SITE_BLOCK_VERSION,
  name: "Search results",
  category: BLOCK_CATEGORIES.WIDGETS,
  description: "The search page's results, or what to try",
  icon: "▤",
  keywords: ["search","results"],
  component: SearchResultsBlock,
  hasChildren: false,
}

export default searchResultsConfig