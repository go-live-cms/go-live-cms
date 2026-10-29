import React from "react"
import { getMediaVariantPreviewURL } from "@gl-admin/lib/api/media"
import { formatDuration, formatTag, isRasterImage, mediaKind, mediaMetaLine, type MediaKind } from "@gl-admin/lib/mediaLibrary"
import { CheckIcon } from "@gl-admin/components/ui/icons"
import type { Media } from "@gl-admin/lib/types"
import "@gl-admin/assets/styles/components/media/media-card.scss"

interface Props {
  media: Media
  onClick?: (media: Media) => void
  // The tile is pressed: open in the side panel, or picked in select mode.
  pressed?: boolean
  // Select mode: the tile shows a check box and a click toggles it.
  selectable?: boolean
}

// One tile of the library grid (#342): the thumb variant (the grid never needs the
// full-size file), the format tag, and the name with its size.
//
// Hidden until #325 lands: the "No alt text" tag in the top-right corner.
const MediaCard: React.FC<Props> = ({ media, onClick, pressed = false, selectable = false }) => {
  const kind = mediaKind(media)
  // A missing file (or a failed load) shows the kind icon instead of a broken image.
  const [broken, setBroken] = React.useState(false)
  const duration = kind === "video" || kind === "audio" ? formatDuration(media.duration) : ""

  return (
    <button
      type="button"
      className={`gl-media-tile${pressed ? " is-pressed" : ""}${selectable ? " is-selectable" : ""}`}
      aria-pressed={pressed}
      data-id={media.id}
      onClick={() => onClick?.(media)}
    >
      <span className={`gl-media-tile__thumb gl-media-tile__thumb--${kind}`}>
        {isRasterImage(media) && !broken ? (
          <img
            src={getMediaVariantPreviewURL(media, "thumb")}
            alt=""
            loading="lazy"
            className="gl-media-tile__image"
            onError={() => setBroken(true)}
          />
        ) : (
          <KindIcon kind={kind} />
        )}
        <span className={`gl-media-tile__tag gl-media-tile__tag--${kind}`}>{formatTag(media)}</span>
        {duration && <span className="gl-media-tile__badge">{duration}</span>}
        {selectable && (
          <span className={`gl-media-tile__check${pressed ? " is-checked" : ""}`} aria-hidden="true">
            {pressed && <CheckIcon size={14} />}
          </span>
        )}
      </span>
      <span className="gl-media-tile__text">
        <span className="gl-media-tile__name" title={media.name}>
          {media.name}
        </span>
        <span className="gl-media-tile__meta">{mediaMetaLine(media)}</span>
      </span>
    </button>
  )
}

export default MediaCard

// The icon a tile shows when there's no image to preview (24px grid, decorative).
export function KindIcon({ kind, size = 28 }: { kind: MediaKind; size?: number }) {
  const paths: Record<MediaKind, React.ReactNode> = {
    image: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="9" cy="9" r="2" />
        <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
      </>
    ),
    vector: (
      <>
        <path d="M12 3 3 8l9 5 9-5z" />
        <path d="m3 16 9 5 9-5" />
      </>
    ),
    video: (
      <>
        <rect x="2" y="6" width="14" height="12" rx="2" />
        <path d="m22 8-6 4 6 4z" />
      </>
    ),
    audio: (
      <>
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </>
    ),
    file: (
      <>
        <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
        <path d="M14 3v6h6" />
      </>
    ),
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="gl-media-tile__icon"
    >
      {paths[kind]}
    </svg>
  )
}
