import { useEffect, useRef, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import FocalPointPicker, { FocalCropPreviews, formatFocalPoint } from "@gl-admin/components/media/FocalPointPicker"
import { KindIcon } from "@gl-admin/components/media/MediaCard"
import UsedIn, { useUsedIn } from "@gl-admin/components/media/UsedIn"
import { DeleteMediaDialog, downloadMedia } from "@gl-admin/components/media/mediaActions"
import { ErrorPage } from "@gl-admin/components/errors/ErrorPages"
import Button from "@gl-admin/components/ui/Button"
import Input from "@gl-admin/components/ui/Input"
import Textarea from "@gl-admin/components/ui/Textarea"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import { DownloadIcon, ReplaceIcon, TrashIcon } from "@gl-admin/components/ui/icons"
import { toast } from "@gl-admin/components/ui/Toast"
import { getMediaById, getMediaVariantPreviewURL, replaceMediaFile, updateMedia } from "@gl-admin/lib/api/media"
import { errorMessage } from "@gl-admin/lib/api/errors"
import { formatDate } from "@gl-admin/utils/formatting"
import {
  formatDimensions,
  formatFileSize,
  formatTag,
  isRasterImage,
  mediaKind,
  replaceHint,
} from "@gl-admin/lib/mediaLibrary"
import { canWriteMedia } from "@gl-admin/lib/roles"
import { useAuthUser } from "@gl-admin/lib/hooks/useAuthUser"
import type { FocalPoint, Media } from "@gl-admin/lib/types"
import "@gl-admin/assets/styles/pages/media.scss"

// A media file's detail page (#342, the "Media detail" board): the focal point with crop
// previews, Replace file, name / alt text / description, where it's used, and its facts.
// Saving and replacing work as the old edit modal did: the focal point is saved with the
// fields, and Replace keeps the id, URL, name, description and alt text.
//
// Hidden until #325 lands: the "Decorative image" option under the alt text.

type Fields = { name: string; alt: string; description: string }

const fieldsOf = (media: Media): Fields => ({
  name: media.name || "",
  alt: media.alt || "",
  description: media.description || "",
})

export default function MediaDetail() {
  const { id } = useParams<{ id: string }>()
  const mediaId = Number(id)
  const navigate = useNavigate()
  const { baseTitle } = useGoLive()
  const user = useAuthUser()

  const [media, setMedia] = useState<Media | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [reload, setReload] = useState(0)
  const [fields, setFields] = useState<Fields>({ name: "", alt: "", description: "" })
  const [focalPoint, setFocalPoint] = useState<FocalPoint | null>(null)
  const [saving, setSaving] = useState(false)
  // null when no replace is running; otherwise the upload fraction (0..1).
  const [replaceProgress, setReplaceProgress] = useState<number | null>(null)
  const [replaceError, setReplaceError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const replaceInput = useRef<HTMLInputElement>(null)
  const usedIn = useUsedIn(Number.isFinite(mediaId) ? mediaId : null)

  useEffect(() => {
    let live = true
    setLoadError(null)
    getMediaById(mediaId)
      .then(({ media }) => {
        if (!live) return
        setMedia(media)
        setFields(fieldsOf(media))
        setFocalPoint(media.focal_point ?? null)
      })
      .catch((e) => live && setLoadError(e))
    return () => {
      live = false
    }
  }, [mediaId, reload])

  useEffect(() => {
    document.title = `${baseTitle} ${media?.name ?? "Media"}`
  }, [baseTitle, media?.name])

  if (loadError) return <ErrorPage error={loadError} onRetry={() => setReload((n) => n + 1)} />
  if (!media) return <DetailSkeleton />

  const canWrite = canWriteMedia(user, media)
  const isImage = isRasterImage(media)
  const kind = mediaKind(media)
  const isReplacing = replaceProgress !== null
  const busy = saving || isReplacing
  const current = media.focal_point ?? null
  const focalChanged = focalPoint?.x !== current?.x || focalPoint?.y !== current?.y
  const stored = fieldsOf(media)
  const dirty =
    focalChanged || fields.name !== stored.name || fields.alt !== stored.alt || fields.description !== stored.description

  const save = async () => {
    setSaving(true)
    try {
      const updated = await updateMedia(media.id, focalChanged ? { ...fields, focal_point: focalPoint } : fields)
      const saved = { ...(updated.media as Media), post_count: (updated.media as Media).post_count ?? media.post_count }
      setMedia(saved)
      setFields(fieldsOf(saved))
      setFocalPoint(saved.focal_point ?? null)
      toast.success("Changes saved")
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't save the changes"))
    } finally {
      setSaving(false)
    }
  }

  // The server only accepts a file of the same type, so the picker is limited to it and
  // a mismatch is caught here before uploading.
  const replace = async (file: File | undefined) => {
    if (!file) return
    setReplaceError(null)
    if (media.mime_type && file.type && file.type !== media.mime_type) {
      setReplaceError(`The replacement must be a ${formatTag(media)} file, like the original.`)
      return
    }
    setReplaceProgress(0)
    try {
      const { media: saved } = await replaceMediaFile(media.id, file, setReplaceProgress)
      setMedia({ ...saved, post_count: saved.post_count ?? media.post_count })
      toast.success("File replaced")
    } catch (e) {
      setReplaceError(e instanceof Error ? e.message : "Replace failed")
    } finally {
      setReplaceProgress(null)
    }
  }

  const set = (key: keyof Fields) => (e: { currentTarget: { value: string } }) => {
    const value = e.currentTarget.value
    setFields((prev) => ({ ...prev, [key]: value }))
  }

  return (
    <div className="gl-media-detail">
      <header className="gl-media-detail__bar">
        <nav aria-label="Breadcrumb" className="gl-media-detail__crumbs">
          <Link to="/media" className="gl-media-detail__crumb">
            Media
          </Link>
          <span aria-hidden="true" className="gl-media-detail__sep">
            /
          </span>
          <h1 aria-current="page" className="gl-media-detail__name" title={media.name}>
            {media.name}
          </h1>
          <span className={`gl-media-tile__tag gl-media-tile__tag--${kind} gl-media-detail__tag`}>{formatTag(media)}</span>
        </nav>
        <div className="gl-media__spacer" />
        <Button variant="secondary" icon={<DownloadIcon />} onClick={() => downloadMedia(media)}>
          Download
        </Button>
        {canWrite && (
          <Button variant="secondary" icon={<TrashIcon />} className="gl-media-detail__delete" onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        )}
      </header>

      <div className="gl-media-detail__columns">
        <section className="gl-media-detail__visual" aria-labelledby="focal-heading">
          {isImage ? (
            <>
              <div className="gl-media-detail__section-head">
                <h2 id="focal-heading">Focal point</h2>
                <span className="gl-media-detail__focal-value" data-testid="focal-point-value" aria-live="polite">
                  {formatFocalPoint(focalPoint)}
                </span>
              </div>
              <p className="gl-media-detail__hint">
                {canWrite
                  ? "Click the part that must stay in view when themes crop this image, or use the arrow keys."
                  : "The part that stays in view when themes crop this image."}
              </p>
              <FocalPointPicker
                src={getMediaVariantPreviewURL(media, "large")}
                alt={fields.alt || media.alt}
                value={focalPoint}
                onChange={canWrite && !busy ? setFocalPoint : undefined}
              />
              {canWrite && focalPoint && (
                <div>
                  <Button variant="ghost" size="sm" onClick={() => setFocalPoint(null)} disabled={busy}>
                    Reset to center
                  </Button>
                </div>
              )}
              <FocalCropPreviews src={getMediaVariantPreviewURL(media, "medium")} value={focalPoint} />
            </>
          ) : (
            <>
              <h2 id="focal-heading" className="gl-media-sr">
                Preview
              </h2>
              <div className="gl-media-detail__file">
                <KindIcon kind={kind} size={40} />
                <span>{media.name}</span>
              </div>
            </>
          )}

          {canWrite && (
            <div className="gl-media-replace">
              <ReplaceIcon size={18} />
              <span className="gl-media-replace__text">
                <span className="gl-media-replace__title">Replace file</span>
                <span className="gl-media-replace__hint">{replaceHint(usedIn.rows?.length ?? null)}</span>
              </span>
              <input
                ref={replaceInput}
                type="file"
                accept={media.mime_type || undefined}
                onChange={(e) => {
                  const file = e.currentTarget.files?.[0]
                  e.currentTarget.value = "" // so picking the same file again still fires onChange
                  replace(file)
                }}
                aria-label="Replacement file"
                hidden
              />
              <Button variant="secondary" loading={isReplacing} disabled={saving} onClick={() => replaceInput.current?.click()}>
                {isReplacing ? "Uploading…" : "Choose file"}
              </Button>
              {isReplacing && (
                <progress className="gl-media-replace__progress" value={replaceProgress ?? 0} max={1} aria-label="Upload progress" />
              )}
              {replaceError && (
                <p className="gl-media-replace__error" role="alert">
                  {replaceError}
                </p>
              )}
            </div>
          )}
        </section>

        <div className="gl-media-detail__side">
          {canWrite ? (
            <form
              className="gl-media-detail__form"
              aria-label="File details"
              onSubmit={(e) => {
                e.preventDefault()
                if (dirty) save()
              }}
            >
              <Input id="media-name" title="Name" value={fields.name} onChange={set("name")} disabled={busy} />
              {(kind === "image" || kind === "vector") && (
                <Textarea
                  id="media-alt"
                  label="Alt text"
                  rows={3}
                  value={fields.alt}
                  onChange={set("alt")}
                  disabled={busy}
                  hint="Describe what the image shows, for people who can't see it."
                />
              )}
              <Textarea id="media-description" label="Description" rows={3} value={fields.description} onChange={set("description")} disabled={busy} />
              <div className="gl-media-detail__save">
                <Button type="submit" variant="primary" size="lg" loading={saving} disabled={!dirty || isReplacing}>
                  Save
                </Button>
                {dirty && (
                  <Button
                    variant="ghost"
                    size="lg"
                    disabled={busy}
                    onClick={() => {
                      setFields(stored)
                      setFocalPoint(current)
                    }}
                  >
                    Discard changes
                  </Button>
                )}
              </div>
            </form>
          ) : (
            <dl className="gl-media-facts gl-media-facts--stacked">
              <dt>Alt text</dt>
              <dd>{media.alt || "None"}</dd>
              <dt>Description</dt>
              <dd>{media.description || "None"}</dd>
            </dl>
          )}

          <hr className="gl-media-detail__rule" />

          <UsedIn rows={usedIn.rows} failed={usedIn.failed} />

          <dl className="gl-media-facts">
            {formatDimensions(media) && (
              <>
                <dt>Dimensions</dt>
                <dd>{formatDimensions(media)}</dd>
              </>
            )}
            <dt>Size</dt>
            <dd>{formatFileSize(media.file_size)}</dd>
            <dt>Uploaded</dt>
            <dd>{formatDate(media.created_at)}</dd>
          </dl>
        </div>
      </div>

      <DeleteMediaDialog
        media={confirmDelete ? [media] : []}
        onClose={() => setConfirmDelete(false)}
        onDeleted={() => navigate("/media")}
      />
    </div>
  )
}

function DetailSkeleton() {
  return (
    <div className="gl-media-detail" aria-busy="true">
      <span role="status" className="gl-media-sr">
        Loading file…
      </span>
      <header className="gl-media-detail__bar">
        <Skeleton width={220} height={20} />
      </header>
      <div className="gl-media-detail__columns">
        <div className="gl-media-detail__visual">
          <Skeleton width="100%" height={360} />
        </div>
        <div className="gl-media-detail__side">
          <Skeleton width="100%" height={36} />
          <Skeleton width="100%" height={80} />
          <Skeleton width="100%" height={80} />
        </div>
      </div>
    </div>
  )
}
