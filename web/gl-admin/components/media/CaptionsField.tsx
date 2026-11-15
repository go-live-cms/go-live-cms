import { useEffect, useId, useState } from "react"
import MediaPicker from "@gl-admin/components/media/MediaPicker"
import Button from "@gl-admin/components/ui/Button"
import Input from "@gl-admin/components/ui/Input"
import { toast } from "@gl-admin/components/ui/Toast"
import { getMediaById, updateMedia } from "@gl-admin/lib/api/media"
import { ApiError, errorMessage } from "@gl-admin/lib/api/errors"
import {
  CAPTIONS_HELP,
  CAPTIONS_LABEL,
  CAPTIONS_LANG_HELP,
  CAPTIONS_NONE,
  captionsErrorMessage,
  captionsLangError,
  captionsSummary,
} from "@gl-admin/lib/mediaCaptions"
import type { Media } from "@gl-admin/lib/types"

// A video's "Captions (VTT)" (#507), on its detail page and the library's side panel: the
// WebVTT file (chosen or uploaded through the shared MediaPicker, #423), its language, and
// Remove. Each change is saved at once (`PUT /media/:id`), like the alt text's own Save in
// the panel; `onUpdated` gets the saved video. Read-only without write access.

export default function CaptionsField({
  media,
  canWrite,
  onUpdated,
}: {
  /** The video. */
  media: Media
  canWrite: boolean
  onUpdated: (media: Media) => void
}) {
  const ids = useId()
  const captionsId = media.captions_media_id ?? null
  const [picking, setPicking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [captions, setCaptions] = useState<Media | null>(null)
  const [lookupFailed, setLookupFailed] = useState(false)
  const [lang, setLang] = useState(media.captions_lang || "")

  useEffect(() => setLang(media.captions_lang || ""), [media.id, media.captions_lang])

  // The captions file's name for the field; looked up when the video names one.
  useEffect(() => {
    setLookupFailed(false)
    if (captionsId === null) {
      setCaptions(null)
      return
    }
    if (captions?.id === captionsId) return
    let live = true
    getMediaById(captionsId)
      .then(({ media: file }) => live && setCaptions(file))
      .catch(() => live && setLookupFailed(true))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captionsId])

  const save = async (data: { captions_media_id?: number | null; captions_lang?: string }, done: string) => {
    setSaving(true)
    try {
      const { media: saved } = await updateMedia(media.id, data)
      onUpdated({ ...media, ...(saved as Media), post_count: (saved as Media).post_count ?? media.post_count })
      toast.success(done)
      return true
    } catch (e) {
      const code = e instanceof ApiError ? e.code ?? undefined : undefined
      toast.error(captionsErrorMessage(code) ?? errorMessage(e, "Couldn't save the captions"))
      return false
    } finally {
      setSaving(false)
    }
  }

  const choose = async (file: Media | null) => {
    setPicking(false)
    if (!file) {
      if (captionsId !== null) await save({ captions_media_id: null }, "Captions removed")
      return
    }
    if (file.id === captionsId) return
    // Shown at once, so the lookup (keyed by the saved id) has nothing to fetch.
    const previous = captions
    setCaptions(file)
    if (!(await save({ captions_media_id: file.id }, "Captions added"))) setCaptions(previous)
  }

  const summary = captionsSummary(captions, media.captions_lang)
  const langChanged = captionsId !== null && lang.trim() !== (media.captions_lang || "")
  const langError = langChanged ? captionsLangError(lang) : undefined

  const fileLine =
    captionsId === null ? CAPTIONS_NONE : summary ? summary.name : lookupFailed ? "Captions file" : "Loading the captions…"

  return (
    <div role="group" aria-labelledby={`${ids}-label`} aria-describedby={`${ids}-help`} className="gl-media-captions">
      <span id={`${ids}-label`} className="gl-media-captions__label">
        {CAPTIONS_LABEL}
      </span>
      <div className="gl-media-captions__file">
        <span className="gl-media-captions__text">
          <span className="gl-media-captions__name">{fileLine}</span>
          {captionsId !== null && summary && <span className="gl-media-captions__meta">{summary.meta}</span>}
        </span>
        {canWrite && (
          <span className="gl-media-captions__actions">
            <Button variant="secondary" size="sm" onClick={() => setPicking(true)} disabled={saving}>
              {captionsId === null ? "Add captions" : "Replace"}
            </Button>
            {captionsId !== null && (
              <Button variant="ghost" size="sm" onClick={() => choose(null)} disabled={saving}>
                Remove
              </Button>
            )}
          </span>
        )}
      </div>
      {canWrite && captionsId !== null && (
        <form
          className="gl-media-captions__lang"
          onSubmit={(e) => {
            e.preventDefault()
            if (langChanged && !langError) void save({ captions_lang: lang.trim() }, "Captions language saved")
          }}
        >
          <Input
            id={`${ids}-lang`}
            title="Captions language"
            value={lang}
            onChange={(e) => setLang(e.currentTarget.value)}
            hint={CAPTIONS_LANG_HELP}
            error={langError}
            disabled={saving}
            unmasked
            maxLength={35}
          />
          {langChanged && (
            <span className="gl-media-captions__lang-actions">
              <Button type="submit" variant="primary" size="sm" loading={saving} disabled={!!langError}>
                Save
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setLang(media.captions_lang || "")} disabled={saving}>
                Cancel
              </Button>
            </span>
          )}
        </form>
      )}
      <span id={`${ids}-help`} className="gl-media-captions__help">
        {CAPTIONS_HELP}
      </span>
      {canWrite && (
        <MediaPicker
          isOpen={picking}
          onClose={() => setPicking(false)}
          onSelect={(file) => void choose(file)}
          kind="captions"
          title="Choose captions"
          current={captions}
          removeLabel="Remove captions"
        />
      )}
    </div>
  )
}
