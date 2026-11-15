import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import { PostTemplateBlock } from "../utils/postBlocks"
import { SITE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

// #489: a site block (utils/postBlocks.tsx), rendered only inside a block template.
export const postTemplateConfig: BlockConfig = {
  type: "post_template",
  version: SITE_BLOCK_VERSION,
  name: "Post template",
  category: BLOCK_CATEGORIES.WIDGETS,
  description: "What each post of a query loop shows",
  icon: "▤",
  keywords: ["post","template","item"],
  component: PostTemplateBlock,
  hasChildren: true,
}

export default postTemplateConfig
