import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import { AuthorCardsBlock } from "../utils/postEndBlocks"
import { SITE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

// #497: a site block (utils/postEndBlocks.tsx), rendered only inside a block template.
export const authorCardsConfig: BlockConfig = {
  type: "author_cards",
  version: SITE_BLOCK_VERSION,
  name: "Author cards",
  category: BLOCK_CATEGORIES.WIDGETS,
  description: "Written by: the post's credited authors",
  icon: "▤",
  keywords: ["author","bio"],
  component: AuthorCardsBlock,
  hasChildren: false,
}

export default authorCardsConfig
