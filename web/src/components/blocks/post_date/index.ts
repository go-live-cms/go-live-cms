import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import { PostDateBlock } from "../utils/postBlocks"
import { SITE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

// #489: a site block (utils/postBlocks.tsx), rendered only inside a block template.
export const postDateConfig: BlockConfig = {
  type: "post_date",
  version: SITE_BLOCK_VERSION,
  name: "Post date",
  category: BLOCK_CATEGORIES.WIDGETS,
  description: "When the post was published or updated",
  icon: "▤",
  keywords: ["date","time"],
  component: PostDateBlock,
  hasChildren: false,
}

export default postDateConfig
