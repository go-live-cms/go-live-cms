import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import HtmlBlock from "./HtmlBlock"
import { HTML_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

export const htmlConfig: BlockConfig = {
  type: "html",
  version: HTML_BLOCK_VERSION,
  name: "Custom HTML",
  category: BLOCK_CATEGORIES.WIDGETS,
  description: "An admin's own markup, sanitized by the API",
  icon: "</>",
  keywords: ["html", "markup", "snippet"],
  priority: 90,

  component: HtmlBlock,
  hasChildren: false,
}

export default htmlConfig
