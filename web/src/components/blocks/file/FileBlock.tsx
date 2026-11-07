import React from "react"
import { fileMetaLine, MEDIA_BLOCK_ICONS, normalizeFileLabel } from "@gl-admin/lib/blocks-spec"
import type { BlockComponentProps } from "../types"
import { blockFileFor, downloadName } from "../utils/mediaFile"

/**
 * File (#423, "Published · media & embeds"): a download link with the file's type and
 * size, and a Download button.
 *
 * `div.file-block > span.file-icon + div.file-text (a + span.file-meta) + a.btn`. The link
 * text is the block's label, else the media's name, else the uploaded file's name. Both
 * links download the file under its uploaded name (the stored one is random, #399). A
 * block whose file is missing or unknown renders nothing (`blockFileFor`).
 */
const FileBlock: React.FC<BlockComponentProps> = ({ block, doc, anchorId }) => {
  const attrs = block.attrs as Record<string, unknown>
  const file = blockFileFor(doc, attrs?.mediaId)
  if (!file) return null

  const filename = downloadName(file.media)
  const label = normalizeFileLabel(attrs?.label) ?? (file.media.name?.trim() || filename || "Download")
  const meta = fileMetaLine(file.media.filename || file.url, file.media.file_size)
  return (
    <div key={block.id} id={anchorId} className="file-block">
      <span className="file-icon" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d={MEDIA_BLOCK_ICONS.file} />
        </svg>
      </span>
      <div className="file-text">
        <a href={file.url} download={filename ?? ""}>
          {label}
        </a>
        <span className="file-meta">{meta}</span>
      </div>
      <a href={file.url} download={filename ?? ""} className="btn btn-secondary file-download" aria-label={`Download ${label}, ${meta}`}>
        Download
      </a>
    </div>
  )
}

export default FileBlock