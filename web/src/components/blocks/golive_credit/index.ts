import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import { GoliveCreditBlock } from "../utils/siteBlocksIV"
import { SITE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

// #498: a site block (utils/siteBlocksIV.tsx), rendered only inside a block template.
export const goliveCreditConfig: BlockConfig = {
  type: "golive_credit",
  version: SITE_BLOCK_VERSION,
  name: "GoLive credit",
  category: BLOCK_CATEGORIES.WIDGETS,
  description: "Published with GoLive",
  icon: "▤",
  keywords: ["credit","powered by","golive"],
  component: GoliveCreditBlock,
  hasChildren: false,
}

export default goliveCreditConfig