import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import SiteTaglineBlock from "./SiteTaglineBlock"
import { SITE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

export const siteTaglineConfig: BlockConfig = {
  type: "site_tagline",
  version: SITE_BLOCK_VERSION,
  name: "Site tagline",
  category: BLOCK_CATEGORIES.WIDGETS,
  description: "The site's tagline, from Settings (templates only)",
  icon: "—",
  keywords: ["site", "tagline", "description"],
  component: SiteTaglineBlock,
  hasChildren: false,
}

export default siteTaglineConfig