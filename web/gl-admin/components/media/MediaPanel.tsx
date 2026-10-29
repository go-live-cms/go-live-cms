import { useEffect, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import Button, { IconButton } from "@gl-admin/components/ui/Button"
import Textarea from "@gl-admin/components/ui/Textarea"
import Drawer from "@gl-admin/components/ui/Drawer"
import { CloseIcon, CopyIcon, DownloadIcon, TrashIcon } from "@gl-admin/components/ui/icons"
import { toast } from "@gl-admin/components/ui/Toast"
import { getMediaVariantPreviewURL, updateMedia } from "@gl-admin/lib/api/media"
import { errorMessage } from "@gl-admin/lib/api/errors"
import { formatDate } from "@gl-admin/utils/formatting"
import { formatDimensions, formatFileSize, isRasterImage, mediaKind, typeLabel } from "@gl-admin/lib/mediaLibrary"
import type { Media } from "@gl-admin/lib/types"
import { KindIcon } from "./MediaCard"
import UsedIn, { useUsedIn } from "./UsedIn"
import { copyMediaURL, downloadMedia } from "./mediaActions"

type MediaPanelProps = {
  media: Media
  // Editing, replacing and deleting (canWriteMedia); without it the panel is read-only.
  canWrite: boolean
  // At phone width the panel is a Drawer over the grid instead of a column beside it.
  asDrawer: boolean
  onClose: () => void
  onUpdated: (media: Media) => void
  onDelete: (media: Media) => void
}

// The library's side panel (#342): a preview, Copy URL / Download / Delete, the alt
// text, the file's facts, where it's used, and "Edit details" for the rest (name,
// description, focal point, replace) on the detail page.
//
// Hidden until #325 lands: the "Decorative image" option. The board's Caption field has
// no backend (media has no caption) and is left out.
export default function MediaPanel({ media, canWrite, asDrawer, onClose, onUpdated, onDelete }: MediaPanelProps) {
  const [alt, setAlt] = useState(media.alt || "")
  const [saving, setSaving] = useState(false)
  const usedIn = useUsedIn(media.id)
  const kind = mediaKind(media)

  // A different file, or this one saved elsewhere: start from what's stored.
  useEffect(() => {
    setAlt(media.alt || "")
  }, [media.id, media.alt])

  const dirty = alt.trim() !== (media.alt || "")

  const saveAlt = async () => {
    setSaving(true)
    try {
      const { media: saved } = await updateMedia(media.id, { alt: alt.trim() })
      onUpdated({ ...media, ...saved, post_count: saved.post_count ?? media.post_count })
      toast.success("Alt text saved")
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't save the alt text"))
    } finally {
      setSaving(false)
    }
  }

  const body: ReactNode = (
    <div className="gl-media-panel__body">
      <div className="gl-media-panel__preview">
        {isRasterImage(media) ? (
          <img src={getMediaVariantPreviewURL(media, "medium")} alt="" className="gl-media-panel__image" />
        ) : (
          <KindIcon kind={kind} size={32} />
        )}
      </div>

      <div className="gl-media-panel__actions">
        <Button variant="secondary" icon={<CopyIcon />} onClick={() => copyMediaURL(media)}>
          Copy URL
        </Button>
        <Button variant="secondary" icon={<DownloadIcon />} onClick={() => downloadMedia(media)}>
          Download
        </Button>
        {canWrite && (
          <IconButton
            variant="secondary"
            aria-label="Delete file"
            icon={<TrashIcon />}
            className="gl-media-panel__delete"
            onClick={() => onDelete(media)}
          />
        )}
      </div>

      {(kind === "image" || kind === "vector") &&
        (canWrite ? (
          <form
            className="gl-media-panel__alt"
            onSubmit={(e) => {
              e.preventDefault()
              if (dirty && alt.trim()) saveAlt()
            }}
          >
            <Textarea
              id="media-panel-alt"
              label="Alt text"
              rows={3}
              value={alt}
              onChange={(e) => setAlt(e.currentTarget.value)}
              hint="Describe what the image shows for people using screen readers."
            />
            {dirty && (
              <div className="gl-media-panel__alt-actions">
                <Button type="submit" variant="primary" size="sm" loading={saving} disabled={!alt.trim()}>
                  Save
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setAlt(media.alt || "")} disabled={saving}>
                  Cancel
                </Button>
              </div>
            )}
          </form>
        ) : (
          <div className="gl-media-panel__field">
            <span className="gl-media-panel__label">Alt text</span>
            <p className="gl-media-panel__value">{media.alt || "None"}</p>
          </div>
        ))}

      <dl className="gl-media-facts">
        <dt>Type</dt>
        <dd>{typeLabel(media)}</dd>
        <dt>Size</dt>
        <dd>{formatFileSize(media.file_size)}</dd>
        {formatDimensions(media) && (
          <>
            <dt>Dimensions</dt>
            <dd>{formatDimensions(media)}</dd>
          </>
        )}
        <dt>Uploaded</dt>
        <dd>{formatDate(media.created_at)}</dd>
      </dl>

      <UsedIn rows={usedIn.rows} failed={usedIn.failed} compact />
    </div>
  )

  const editLink = (
    <Link to={`/media/${media.id}`} className="gl-media-panel__edit">
      {canWrite ? "Edit details" : "Details"}
    </Link>
  )

  if (asDrawer) {
    return (
      <Drawer isOpen onClose={onClose} title={media.name} closeLabel="Close details" footer={editLink}>
        {body}
      </Drawer>
    )
  }

  return (
    <aside className="gl-media-panel" aria-label="File details">
      <div className="gl-media-panel__header">
        <h2 className="gl-media-panel__title" title={media.name}>
          {media.name}
        </h2>
        {editLink}
        <IconButton aria-label="Close details" icon={<CloseIcon />} onClick={onClose} />
      </div>
      {body}
    </aside>
  )
}
