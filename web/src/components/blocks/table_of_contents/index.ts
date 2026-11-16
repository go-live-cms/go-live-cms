import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import { TableOfContentsBlock } from "../utils/postEndBlocks"
import { SITE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

// #497: a site block (utils/postEndBlocks.tsx), rendered only inside a block template.
export const tableOfContentsConfig: BlockConfig = {
  type: "table_of_contents",
  version: SITE_BLOCK_VERSION,
  name: "Table of contents",
  category: BLOCK_CATEGORIES.WIDGETS,
  description: "On this page: the post's headings",
  icon: "▤",
  keywords: ["toc","headings"],
  component: TableOfContentsBlock,
  hasChildren: false,
}

export default tableOfContentsConfig
