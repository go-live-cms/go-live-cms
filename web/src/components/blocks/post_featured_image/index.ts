import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import { PostFeaturedImageBlock } from "../utils/postBlocks"
import { SITE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

// #489: a site block (utils/postBlocks.tsx), rendered only inside a block template.
export const postFeaturedImageConfig: BlockConfig = {
  type: "post_featured_image",
  version: SITE_BLOCK_VERSION,
  name: "Featured image",
  category: BLOCK_CATEGORIES.WIDGETS,
  description: "The post's featured image",
  icon: "▤",
  keywords: ["image","featured","thumbnail"],
  component: PostFeaturedImageBlock,
  hasChildren: false,
}

export default postFeaturedImageConfig
