import { useEffect, useState } from "react"
import type { Editor as TiptapEditor } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { getMediaVariantPreviewURL } from "@gl-admin/lib/api/media"
import { isRasterImage } from "@gl-admin/lib/mediaLibrary"
import { knownMedia, lookupMedia, type MediaLookup } from "@gl-admin/lib/mediaLookup"
import { MEDIA_BLOCK_ICONS } from "@gl-admin/lib/blocks-spec"
import { chooseMediaFor } from "../blocks/mediaPicking"
import { mediaFileLine, MISSING_TITLES, type MediaNode } from "../extensions/MediaBlockViews"
import { resolveEditorBlock, type BlockRef } from "../utils/blockTree"

// The settings panel's Block tab for a media block (#423, the canvas's settings panels for
// video, audio and file): the file it shows ("launch-walkthrough.mp4", "1:42 · 18 MB · from
// Media") with Replace, which opens the shared picker. Video and audio say they never play
// on their own.

const NEVER_AUTOPLAY = "Readers start it themselves; it never plays on its own."

export function useMediaLookup(mediaId: unknown): MediaLookup | { status: "loading" } | null {
  const id = typeof mediaId === "number" && Number.isInteger(mediaId) && mediaId > 0 ? mediaId : null
  const [state, setState] = useState<{ id: number | null; lookup: MediaLookup | { status: "loading" } | null }>(() => ({
    id,
    lookup: id === null ? null : (knownMedia(id) ?? { status: "loading" }),
  }))
  useEffect(() => {
    if (id === null) return setState({ id, lookup: null })
    let live = true
    setState({ id, lookup: knownMedia(id) ?? { status: "loading" } })
    void lookupMedia(id).then((lookup) => live && setState({ id, lookup }))
    return () => {
      live = false
    }
  }, [id])
  return state.id === id ? state.lookup : null
}

export default function MediaBlockSettings({ editor, node, blockRef }: { editor: TiptapEditor; node: PMNode; blockRef: BlockRef }) {
  const kind = node.type.name as MediaNode
  const lookup = useMediaLookup(node.attrs.mediaId)
  const media = lookup?.status === "found" ? lookup.media : null

  const replace = () => {
    const block = resolveEditorBlock(editor.state.doc, blockRef)
    if (block) chooseMediaFor(editor, block.pos)
  }

  const name = media
    ? media.original_filename || media.name
    : lookup?.status === "missing"
      ? MISSING_TITLES[kind]
      : lookup?.status === "loading"
        ? "Loading…"
        : lookup?.status === "unknown"
          ? "Couldn't load the file's details"
          : "No file yet"

  return (
    <div className="block-settings__media">
      <div className="block-settings__filerow">
        {media && isRasterImage(media) ? (
          <img src={getMediaVariantPreviewURL(media, "thumb")} alt="" className="block-settings__file-thumb" />
        ) : (
          <span className="block-settings__file-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d={lookup?.status === "missing" ? MEDIA_BLOCK_ICONS.missing : MEDIA_BLOCK_ICONS[kind]} />
            </svg>
          </span>
        )}
        <div className="block-settings__file-text">
          <b className="block-settings__file-name">{name}</b>
          {media && <span className="block-settings__file-meta">{[mediaFileLine(kind, media), "from Media"].filter(Boolean).join(" · ")}</span>}
        </div>
        {editor.isEditable && (
          <button type="button" className="block-settings__file-replace" onClick={replace}>
            {typeof node.attrs.mediaId === "number" ? "Replace" : "Choose from Media"}
          </button>
        )}
      </div>
      {(kind === "video" || kind === "audio") && <p className="post-settings__hint">{NEVER_AUTOPLAY}</p>}
    </div>
  )
}
