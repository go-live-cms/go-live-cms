import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import EmbedBlock from "./EmbedBlock"
import { EMBED_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

export const embedConfig: BlockConfig = {
  type: "embed",
  version: EMBED_BLOCK_VERSION,
  name: "Embed",
  category: BLOCK_CATEGORIES.EMBED,
  description: "Content from an allowed site, loaded only when a reader asks for it",
  icon: "🔗",
  keywords: ["embed", "youtube", "vimeo", "x", "codepen", "soundcloud", "spotify"],
  priority: 30,

  component: EmbedBlock,
  hasChildren: false,
}

export default embedConfig
