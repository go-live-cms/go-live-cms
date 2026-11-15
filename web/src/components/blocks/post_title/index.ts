import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import { PostTitleBlock } from "../utils/postBlocks"
import { SITE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

// #489: a site block (utils/postBlocks.tsx), rendered only inside a block template.
export const postTitleConfig: BlockConfig = {
  type: "post_title",
  version: SITE_BLOCK_VERSION,
  name: "Post title",
  category: BLOCK_CATEGORIES.WIDGETS,
  description: "The post's title",
  icon: "▤",
  keywords: ["title","heading"],
  component: PostTitleBlock,
  hasChildren: false,
}

export default postTitleConfig
