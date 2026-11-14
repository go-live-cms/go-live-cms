import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import NavigationBlock from "./NavigationBlock"
import { SITE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

export const navigationConfig: BlockConfig = {
  type: "navigation",
  version: SITE_BLOCK_VERSION,
  name: "Navigation",
  category: BLOCK_CATEGORIES.WIDGETS,
  description: "A menu: a theme location's, or one by name (templates only)",
  icon: "≡",
  keywords: ["menu", "navigation", "links"],
  component: NavigationBlock,
  hasChildren: false,
}

export default navigationConfig