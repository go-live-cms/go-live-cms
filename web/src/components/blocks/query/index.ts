import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import { QueryBlock } from "../utils/postBlocks"
import { SITE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

// #489: a site block (utils/postBlocks.tsx), rendered only inside a block template.
export const queryConfig: BlockConfig = {
  type: "query",
  version: SITE_BLOCK_VERSION,
  name: "Query loop",
  category: BLOCK_CATEGORIES.WIDGETS,
  description: "A list of posts: the page's own, or the ones you choose (templates only)",
  icon: "▤",
  keywords: ["query","loop","posts","list"],
  component: QueryBlock,
  hasChildren: true,
}

export default queryConfig
