import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import { PostBylineBlock } from "../utils/postBlocks"
import { SITE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

// #489: a site block (utils/postBlocks.tsx), rendered only inside a block template.
export const postBylineConfig: BlockConfig = {
  type: "post_byline",
  version: SITE_BLOCK_VERSION,
  name: "Post byline",
  category: BLOCK_CATEGORIES.WIDGETS,
  description: "Who the post credits",
  icon: "▤",
  keywords: ["author","byline"],
  component: PostBylineBlock,
  hasChildren: false,
}

export default postBylineConfig
