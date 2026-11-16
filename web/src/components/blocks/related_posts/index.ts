import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import { RelatedPostsBlock } from "../utils/postEndBlocks"
import { SITE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

// #497: a site block (utils/postEndBlocks.tsx), rendered only inside a block template.
export const relatedPostsConfig: BlockConfig = {
  type: "related_posts",
  version: SITE_BLOCK_VERSION,
  name: "Related posts",
  category: BLOCK_CATEGORIES.WIDGETS,
  description: "More to read: posts related to the page's post",
  icon: "▤",
  keywords: ["related","more"],
  component: RelatedPostsBlock,
  hasChildren: false,
}

export default relatedPostsConfig
