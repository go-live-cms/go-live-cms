import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import { AuthorAvatarBlock } from "../utils/siteBlocksIV"
import { SITE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

// #498: a site block (utils/siteBlocksIV.tsx), rendered only inside a block template.
export const authorAvatarConfig: BlockConfig = {
  type: "author_avatar",
  version: SITE_BLOCK_VERSION,
  name: "Author avatar",
  category: BLOCK_CATEGORIES.WIDGETS,
  description: "The author page's photo or initial",
  icon: "▤",
  keywords: ["author","photo","avatar"],
  component: AuthorAvatarBlock,
  hasChildren: false,
}

export default authorAvatarConfig