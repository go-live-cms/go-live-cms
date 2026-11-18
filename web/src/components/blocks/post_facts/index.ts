import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import { PostFactsBlock } from "../utils/siteBlocksIV"
import { SITE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

// #498: a site block (utils/siteBlocksIV.tsx), rendered only inside a block template.
export const postFactsConfig: BlockConfig = {
  type: "post_facts",
  version: SITE_BLOCK_VERSION,
  name: "Post details",
  category: BLOCK_CATEGORIES.WIDGETS,
  description: "The post's dates and reading time",
  icon: "▤",
  keywords: ["dates","published","updated","reading time"],
  component: PostFactsBlock,
  hasChildren: false,
}

export default postFactsConfig