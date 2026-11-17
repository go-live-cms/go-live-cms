import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import { SiteCopyrightBlock } from "../utils/siteBlocksIV"
import { SITE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

// #498: a site block (utils/siteBlocksIV.tsx), rendered only inside a block template.
export const siteCopyrightConfig: BlockConfig = {
  type: "site_copyright",
  version: SITE_BLOCK_VERSION,
  name: "Copyright",
  category: BLOCK_CATEGORIES.WIDGETS,
  description: "The year and the site's title",
  icon: "▤",
  keywords: ["copyright","footer"],
  component: SiteCopyrightBlock,
  hasChildren: false,
}

export default siteCopyrightConfig