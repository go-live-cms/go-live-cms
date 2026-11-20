import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import { CommentsBlock } from "../utils/commentsBlock"
import { SITE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

// #500: a site block (utils/commentsBlock.tsx), rendered only inside a single or page block template.
export const commentsConfig: BlockConfig = {
  type: "comments",
  version: SITE_BLOCK_VERSION,
  name: "Comments",
  category: BLOCK_CATEGORIES.WIDGETS,
  description: "The post's reader comments and the form",
  icon: "▤",
  keywords: ["comments", "discussion", "replies"],
  component: CommentsBlock,
  hasChildren: false,
}

export default commentsConfig
