import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import { PostNavigationBlock } from "../utils/postBlocks"
import { SITE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

// #489: a site block (utils/postBlocks.tsx), rendered only inside a block template.
export const postNavigationConfig: BlockConfig = {
  type: "post_navigation",
  version: SITE_BLOCK_VERSION,
  name: "Post navigation",
  category: BLOCK_CATEGORIES.WIDGETS,
  description: "Older and newer posts",
  icon: "▤",
  keywords: ["next","previous","older","newer"],
  component: PostNavigationBlock,
  hasChildren: false,
}

export default postNavigationConfig
