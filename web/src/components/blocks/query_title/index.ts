import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import { QueryTitleBlock } from "../utils/postBlocks"
import { SITE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

// #489: a site block (utils/postBlocks.tsx), rendered only inside a block template.
export const queryTitleConfig: BlockConfig = {
  type: "query_title",
  version: SITE_BLOCK_VERSION,
  name: "Query title",
  category: BLOCK_CATEGORIES.WIDGETS,
  description: "What the page lists: a category, an author, a search",
  icon: "▤",
  keywords: ["archive","title"],
  component: QueryTitleBlock,
  hasChildren: false,
}

export default queryTitleConfig
