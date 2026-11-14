import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import TemplatePartBlock from "./TemplatePartBlock"
import { SITE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

export const templatePartConfig: BlockConfig = {
  type: "template_part",
  version: SITE_BLOCK_VERSION,
  name: "Template part",
  category: BLOCK_CATEGORIES.LAYOUT,
  description: "A header, a footer or another part (templates only)",
  icon: "▭",
  keywords: ["part", "header", "footer"],
  component: TemplatePartBlock,
  hasChildren: false,
}

export default templatePartConfig