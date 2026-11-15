import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import { QueryNoResultsBlock } from "../utils/postBlocks"
import { SITE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

// #489: a site block (utils/postBlocks.tsx), rendered only inside a block template.
export const queryNoResultsConfig: BlockConfig = {
  type: "query_no_results",
  version: SITE_BLOCK_VERSION,
  name: "No results",
  category: BLOCK_CATEGORIES.WIDGETS,
  description: "What a query loop shows when it finds no posts",
  icon: "▤",
  keywords: ["empty","none"],
  component: QueryNoResultsBlock,
  hasChildren: true,
}

export default queryNoResultsConfig
