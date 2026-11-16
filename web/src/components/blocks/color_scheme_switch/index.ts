import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import { ColorSchemeSwitchBlock } from "../utils/postEndBlocks"
import { SITE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

// #497: a site block (utils/postEndBlocks.tsx), rendered only inside a block template.
export const colorSchemeSwitchConfig: BlockConfig = {
  type: "color_scheme_switch",
  version: SITE_BLOCK_VERSION,
  name: "Colour scheme switch",
  category: BLOCK_CATEGORIES.WIDGETS,
  description: "Light, Dark or System",
  icon: "▤",
  keywords: ["theme","dark"],
  component: ColorSchemeSwitchBlock,
  hasChildren: false,
}

export default colorSchemeSwitchConfig
