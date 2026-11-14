import { useEffect, useId, useState } from "react"
import MediaPicker from "@gl-admin/components/media/MediaPicker"
import Button from "@gl-admin/components/ui/Button"
import { getMediaById, getMediaVariantPreviewURL } from "@gl-admin/lib/api/media"
import type { Media } from "@gl-admin/lib/api/types"
import type { SiteLogo } from "@gl-admin/lib/api/settings"
import { currentLogoLabel, SITE_LOGO_HELP, SITE_LOGO_NONE, summaryFromMedia, summaryFromSaved, type LogoSummary } from "@gl-admin/lib/siteLogo"

// Settings › General's "Site logo" (#488, the redesign canvas's Settings board): the image,
// its file name and "SVG · 512 × 512", Replace (the media library, images only) and Remove.
// It edits the form's draft (`site_logo_media_id`), saved with the rest of the page.

export default function SiteLogoField({
  value,
  saved,
  onChange,
}: {
  value: number | null
  /** The logo as the settings answer has it (`site_logo`). */
  saved: SiteLogo | null
  onChange: (id: number | null) => void
}) {
  const ids = useId()
  const [picking, setPicking] = useState(false)
  // A logo picked since the page loaded, or one looked up because the saved answer lacked it.
  const [picked, setPicked] = useState<LogoSummary | null>(null)

  const shown: LogoSummary | null =
    value === null ? null : picked?.id === value ? picked : saved?.id === value ? summaryFromSaved(saved) : null

  useEffect(() => {
    if (value === null || shown) return
    let live = true
    getMediaById(value)
      .then(({ media }) => live && setPicked(summaryFromMedia(media)))
      .catch(() => live && setPicked(null))
    return () => {
      live = false
    }
  }, [value, shown])

  const choose = (media: Media | null) => {
    setPicking(false)
    if (!media) {
      onChange(null)
      return
    }
    setPicked(summaryFromMedia(media))
    onChange(media.id)
  }

  return (
    <div role="group" aria-labelledby={`${ids}-label`} aria-describedby={`${ids}-help`} className="is-wide gl-settings__logo-field">
      <span id={`${ids}-label`} className="gl-settings__label">
        Site logo <span className="gl-settings__optional">· optional</span>
      </span>
      <div className="gl-settings__logo">
        {shown ? (
          <>
            <span className="gl-settings__logo-preview" role="img" aria-label={currentLogoLabel(shown)}>
              <img src={getMediaVariantPreviewURL(shown.media, "thumb")} alt="" />
            </span>
            <span className="gl-settings__logo-file">
              <span className="gl-settings__logo-name">{shown.name}</span>
              <span className="gl-settings__logo-meta">{shown.meta}</span>
            </span>
            <Button variant="secondary" size="sm" onClick={() => setPicking(true)}>
              Replace
            </Button>
            <Button variant="ghost" size="sm" className="gl-settings__logo-remove" onClick={() => onChange(null)}>
              Remove
            </Button>
          </>
        ) : (
          <>
            <span className="gl-settings__logo-file">
              <span className="gl-settings__logo-name">{value === null ? SITE_LOGO_NONE : "Loading the logo…"}</span>
            </span>
            <Button variant="secondary" size="sm" onClick={() => setPicking(true)}>
              Choose a logo
            </Button>
          </>
        )}
      </div>
      <span id={`${ids}-help`} className="gl-settings__logo-help">
        {SITE_LOGO_HELP}
      </span>
      <MediaPicker
        isOpen={picking}
        onClose={() => setPicking(false)}
        onSelect={choose}
        kind="image"
        title="Choose a site logo"
        current={(shown?.media as Media | undefined) ?? null}
        removeLabel="Remove logo"
      />
    </div>
  )
}