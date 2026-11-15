import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import { QueryPaginationBlock } from "../utils/postBlocks"
import { SITE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

// #489: a site block (utils/postBlocks.tsx), rendered only inside a block template.
export const queryPaginationConfig: BlockConfig = {
  type: "query_pagination",
  version: SITE_BLOCK_VERSION,
  name: "Pagination",
  category: BLOCK_CATEGORIES.WIDGETS,
  description: "The page's list's numbered pages",
  icon: "▤",
  keywords: ["pages","pager","next"],
  component: QueryPaginationBlock,
  hasChildren: false,
}

export default queryPaginationConfig
