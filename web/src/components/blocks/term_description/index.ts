import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import { TermDescriptionBlock } from "../utils/postBlocks"
import { SITE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

// #489: a site block (utils/postBlocks.tsx), rendered only inside a block template.
export const termDescriptionConfig: BlockConfig = {
  type: "term_description",
  version: SITE_BLOCK_VERSION,
  name: "Term description",
  category: BLOCK_CATEGORIES.WIDGETS,
  description: "The listed category's or tag's description",
  icon: "▤",
  keywords: ["category","tag","description"],
  component: TermDescriptionBlock,
  hasChildren: false,
}

export default termDescriptionConfig
