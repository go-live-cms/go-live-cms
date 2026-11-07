import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import AudioBlock from "./AudioBlock"
import { AUDIO_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

export const audioConfig: BlockConfig = {
  type: "audio",
  version: AUDIO_BLOCK_VERSION,
  name: "Audio",
  category: BLOCK_CATEGORIES.MEDIA,
  description: "An audio file from the media library, played by the browser",
  icon: "♪",
  keywords: ["audio", "sound", "podcast", "music", "mp3"],
  priority: 21,

  component: AudioBlock,
  hasChildren: false,
}

export default audioConfig