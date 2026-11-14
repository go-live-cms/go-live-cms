import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import SiteLogoBlock from "./SiteLogoBlock"
import { SITE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

export const siteLogoConfig: BlockConfig = {
  type: "site_logo",
  version: SITE_BLOCK_VERSION,
  name: "Site logo",
  category: BLOCK_CATEGORIES.WIDGETS,
  description: "The site's logo, from Settings (templates only)",
  icon: "◆",
  keywords: ["site", "logo", "brand"],
  component: SiteLogoBlock,
  hasChildren: false,
}

export default siteLogoConfig