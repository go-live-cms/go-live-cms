import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import { QueryTotalBlock } from "../utils/siteBlocksIV"
import { SITE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

// #498: a site block (utils/siteBlocksIV.tsx), rendered only inside a block template.
export const queryTotalConfig: BlockConfig = {
  type: "query_total",
  version: SITE_BLOCK_VERSION,
  name: "Query total",
  category: BLOCK_CATEGORIES.WIDGETS,
  description: "How many the page lists",
  icon: "▤",
  keywords: ["count","total","posts"],
  component: QueryTotalBlock,
  hasChildren: false,
}

export default queryTotalConfig