import React from "react"
import { captionRuns } from "@gl-admin/lib/blocks-spec"
import type { BlockComponentProps } from "../types"
import { renderContent } from "../utils/contentRenderer"
import { blockFileFor, downloadName } from "../utils/mediaFile"

/**
 * Video and audio (#423, the canvas's "Published · media & embeds"): the browser's own
 * player with its controls, never playing on its own (no `autoplay`, `preload="none"`:
 * nothing is fetched until the reader presses play), and the caption under it.
 *
 * `figure.video-block > video` / `figure.audio-block > audio`, then `figcaption`. The
 * player is named by the caption's text, else the media's name. Inside it, for a browser
 * that can't play the file, a link to download it. A block whose file is missing or
 * unknown renders nothing, caption included (`blockFileFor`).
 */
export function PlayableBlock({ block, doc, anchorId, kind }: BlockComponentProps & { kind: "video" | "audio" }) {
  const attrs = block.attrs as Record<string, unknown>
  const file = blockFileFor(doc, attrs?.mediaId)
  if (!file) return null

  const caption = captionRuns(attrs?.caption)
  const name = caption.map((run) => run.text).join("").trim() || file.media.name?.trim() || undefined
  const Player = kind
  return (
    <figure key={block.id} id={anchorId} className={`${kind}-block`}>
      <Player controls preload="none" playsInline={kind === "video" ? true : undefined} src={file.url} aria-label={name}>
        <a href={file.url} download={downloadName(file.media) ?? ""}>
          {kind === "video" ? "Download the video" : "Download the audio"}
        </a>
      </Player>
      {caption.length > 0 && <figcaption>{renderContent(caption)}</figcaption>}
    </figure>
  )
}

const VideoBlock: React.FC<BlockComponentProps> = (props) => <PlayableBlock {...props} kind="video" />

export default VideoBlock
