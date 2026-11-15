import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import { PostExcerptBlock } from "../utils/postBlocks"
import { SITE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

// #489: a site block (utils/postBlocks.tsx), rendered only inside a block template.
export const postExcerptConfig: BlockConfig = {
  type: "post_excerpt",
  version: SITE_BLOCK_VERSION,
  name: "Post excerpt",
  category: BLOCK_CATEGORIES.WIDGETS,
  description: "The post's excerpt",
  icon: "▤",
  keywords: ["excerpt","summary"],
  component: PostExcerptBlock,
  hasChildren: false,
}

export default postExcerptConfig
