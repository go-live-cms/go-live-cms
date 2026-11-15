import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import { PostContentBlock } from "../utils/postBlocks"
import { SITE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

// #489: a site block (utils/postBlocks.tsx), rendered only inside a block template.
export const postContentConfig: BlockConfig = {
  type: "post_content",
  version: SITE_BLOCK_VERSION,
  name: "Post content",
  category: BLOCK_CATEGORIES.WIDGETS,
  description: "The post's blocks (templates only)",
  icon: "▤",
  keywords: ["content","body"],
  component: PostContentBlock,
  hasChildren: false,
}

export default postContentConfig
