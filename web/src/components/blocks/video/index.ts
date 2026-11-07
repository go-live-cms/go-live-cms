import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import VideoBlock from "./VideoBlock"
import { VIDEO_BLOCK_VERSION } from "@gl-admin/lib/blocks-spec"

export const videoConfig: BlockConfig = {
  type: "video",
  version: VIDEO_BLOCK_VERSION,
  name: "Video",
  category: BLOCK_CATEGORIES.MEDIA,
  description: "A video from the media library, played by the browser",
  icon: "▶",
  keywords: ["video", "movie", "clip", "mp4"],
  priority: 20,

  component: VideoBlock,
  hasChildren: false,
}

export default videoConfig