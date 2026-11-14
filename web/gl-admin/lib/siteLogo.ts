import { fileTypeTag } from "@gl-admin/lib/blocks-spec/media"
import type { Media } from "@gl-admin/lib/api/types"
import type { SiteLogo } from "@gl-admin/lib/api/settings"

// Settings › General's "Site logo" (#488, the redesign canvas's Settings board): the image
// the Site logo block shows. Rules and wording for `components/settings/SiteLogoField.tsx`.

export const SITE_LOGO_HELP =
  "Shown by the Site logo block in your site’s templates, and by themes that support a logo. Without one, the site name shows as text. Replace opens your media library."
export const SITE_LOGO_NONE = "No logo yet"

/** What the field shows for a logo: a name and "SVG · 512 × 512". */
export interface LogoSummary {
  id: number
  name: string
  meta: string
  alt: string
  /** A media-shaped value for the picker's `current` and the preview URL. */
  media: Pick<Media, "id" | "media_path" | "changed_at" | "variants" | "name" | "alt" | "mime_type" | "original_filename" | "file_size" | "width" | "height">
}

export function logoMeta(fileName: string | null | undefined, width?: number | null, height?: number | null): string {
  const type = fileTypeTag(fileName)
  return width && height ? `${type} · ${width} × ${height}` : type
}

export function summaryFromMedia(media: Media): LogoSummary {
  const fileName = media.original_filename || media.name
  return { id: media.id, name: fileName || media.name, meta: logoMeta(fileName, media.width, media.height), alt: media.alt ?? "", media }
}

export function summaryFromSaved(logo: SiteLogo): LogoSummary {
  const fileName = logo.filename || logo.name
  return {
    id: logo.id,
    name: fileName || logo.name,
    meta: logoMeta(fileName, logo.width, logo.height),
    alt: logo.alt ?? "",
    media: {
      id: logo.id,
      media_path: logo.media_path,
      // The settings answer doesn't carry the media's changed_at; the path is the version.
      changed_at: "",
      variants: logo.variants ?? {},
      name: logo.name,
      alt: logo.alt,
      mime_type: logo.mime_type,
      original_filename: logo.filename,
      file_size: 0,
      width: logo.width,
      height: logo.height,
    },
  }
}

/** The preview's accessible name: "Current logo: a green leaf", or the file's name. */
export function currentLogoLabel(summary: LogoSummary): string {
  return `Current logo: ${summary.alt.trim() || summary.name}`
}