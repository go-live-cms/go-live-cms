import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import SiteTitleBlock from "./SiteTitleBlock"
import { SITE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

export const siteTitleConfig: BlockConfig = {
  type: "site_title",
  version: SITE_BLOCK_VERSION,
  name: "Site title",
  category: BLOCK_CATEGORIES.WIDGETS,
  description: "The site's name, from Settings (templates only)",
  icon: "T",
  keywords: ["site", "title", "name"],
  component: SiteTitleBlock,
  hasChildren: false,
}

export default siteTitleConfig