import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import { PostTermsBlock } from "../utils/postBlocks"
import { SITE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

// #489: a site block (utils/postBlocks.tsx), rendered only inside a block template.
export const postTermsConfig: BlockConfig = {
  type: "post_terms",
  version: SITE_BLOCK_VERSION,
  name: "Post terms",
  category: BLOCK_CATEGORIES.WIDGETS,
  description: "The post's category or tags",
  icon: "▤",
  keywords: ["category","tags","terms"],
  component: PostTermsBlock,
  hasChildren: false,
}

export default postTermsConfig
