import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import FileBlock from "./FileBlock"
import { FILE_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

export const fileConfig: BlockConfig = {
  type: "file",
  version: FILE_BLOCK_VERSION,
  name: "File",
  category: BLOCK_CATEGORIES.MEDIA,
  description: "A download link to a file from the media library",
  icon: "⎙",
  keywords: ["file", "download", "pdf", "document", "attachment"],
  priority: 22,

  component: FileBlock,
  hasChildren: false,
}

export default fileConfig