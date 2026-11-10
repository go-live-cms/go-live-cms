/**
 * The media blocks (#423, design `docs/design/block-library.md` 3.4): image, video, audio
 * and file. Each one stores a media library item by its id (`attrs.mediaId`, a number) and
 * nothing that says where the file is: the public page gets the URL, type and size from
 * the `media` map the API attaches to a served doc (`api/post_block_media.go`), so files
 * reach readers only through `/uploads`. The image block also keeps the `src` it always
 * had (it renders from that when the lookup failed).
 *
 * Pure data and functions (no React, ProseMirror or Zod), shared by the editor, the
 * collab server, the public renderer and the tests.
 */

/** Video and audio (#423): `mediaId`, `caption` (runs, like an image's). Version 1. */
export const VIDEO_BLOCK_VERSION = 1
export const AUDIO_BLOCK_VERSION = 1
/** File (#423): `mediaId`, `label` (plain text; absent = the file's name). Version 1. */
export const FILE_BLOCK_VERSION = 1

/**
 * The media blocks' icons (the blocks canvas's, 24×24 strokes): the menus, the editor's
 * views and the public file row show the same ones. `missing` is the crossed-out image of
 * "A media file that's missing".
 */
export const MEDIA_BLOCK_ICONS = {
  image: "M3 3h18v18H3zM8.5 8.5h.01M21 15l-5-5L5 21",
  video: "M3 5h13v14H3zM16 10l5-3v10l-5-3",
  audio: "M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0a3 3 0 1 1 6 0M21 16a3 3 0 1 1-6 0a3 3 0 1 1 6 0",
  file: "M14 3H6v18h12V7zM14 3v4h4",
  gallery: "M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z",
  cover: "M3 4h18v16H3zM7 15h10M7 11h6",
  media_text: "M3 5h8v14H3zM14 8h7M14 12h7M14 16h5",
  missing: "M3 3h18v18H3zM21 15l-5-5-4 4M3 3l18 18",
} as const

/** The media library's kinds a picker filters by: the API's `GET /media?type=` values. */
export const MEDIA_PICKER_KINDS = ["image", "video", "audio", "document"] as const
export type MediaPickerKind = (typeof MEDIA_PICKER_KINDS)[number]

/** Block Spec type → the kind of media it holds (the picker's filter). */
export const MEDIA_BLOCK_KINDS = {
  image: "image",
  video: "video",
  audio: "audio",
  file: "document",
  // #427: containers that show one image by the same `attrs.mediaId`.
  cover: "image",
  media_text: "image",
} as const satisfies Record<string, MediaPickerKind>

export type MediaBlockType = keyof typeof MEDIA_BLOCK_KINDS

/** The core block types that show a media item by `attrs.mediaId` (the API's `mediaBlockTypes`). */
export const MEDIA_BLOCK_TYPES = Object.keys(MEDIA_BLOCK_KINDS) as MediaBlockType[]

export function isMediaBlockType(type: unknown): type is MediaBlockType {
  return typeof type === "string" && Object.prototype.hasOwnProperty.call(MEDIA_BLOCK_KINDS, type)
}

/**
 * The `accept` attribute of a file input for a kind: what the API's upload takes
 * (`allowedUploadTypes` in `api/media_utils.go`) and a browser plays. A document is what
 * the API's `type=document` lists (`application/*`): PDF and Word files.
 */
export const MEDIA_KIND_ACCEPT: Record<MediaPickerKind, string> = {
  image: "image/jpeg,image/png,image/gif,image/webp,image/bmp",
  video: "video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov",
  audio: "audio/mpeg,audio/wav,audio/ogg,audio/mp4,.mp3,.wav,.ogg,.m4a",
  document: "application/pdf,.pdf,.doc,.docx",
}

/** Whether a MIME type belongs to a kind, by the API's own prefixes (`getMimeTypeFilter`). */
export function mimeMatchesKind(mime: string | null | undefined, kind: MediaPickerKind): boolean {
  const value = mime ?? ""
  return kind === "document" ? value.startsWith("application/") : value.startsWith(`${kind}/`)
}

/** Longest file label, in code points (runes in the API's sanitizer, `fileLabelMaxRunes`). */
export const FILE_LABEL_MAX_LENGTH = 200

/** At most FILE_LABEL_MAX_LENGTH code points (an input's maxLength counts UTF-16 units). */
export function capFileLabel(value: string): string {
  const points = [...value]
  return points.length > FILE_LABEL_MAX_LENGTH ? points.slice(0, FILE_LABEL_MAX_LENGTH).join("") : value
}

/**
 * A file label as stored, exactly as the API sanitizer makes it (a quote citation's
 * rules): control characters as spaces, trimmed, at most FILE_LABEL_MAX_LENGTH code
 * points, null when empty (the file's name is shown instead).
 */
export function normalizeFileLabel(value: unknown): string | null {
  if (typeof value !== "string") return null
  const label = capFileLabel(value.replace(/\p{Cc}/gu, " ").trim()).trim()
  return label === "" ? null : label
}

/** "240 KB", "1.4 MB": one decimal only where it says something. Empty for no size. */
export function formatFileSize(bytes: number | null | undefined): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return ""
  const units = ["B", "KB", "MB", "GB"]
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / Math.pow(1024, i)
  const shown = i === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10
  return `${shown} ${units[i]}`
}

/** The file's format as a short tag: its extension in capitals ("PDF"), else "FILE". */
export function fileTypeTag(fileName: string | null | undefined): string {
  const name = (fileName ?? "").split(/[/\\]/).pop() ?? ""
  const dot = name.lastIndexOf(".")
  const ext = dot > 0 ? name.slice(dot + 1) : ""
  return /^[a-z0-9]{1,8}$/i.test(ext) ? ext.toUpperCase() : "FILE"
}

/** The line under a file's name ("PDF · 240 KB"), the size left out when unknown. */
export function fileMetaLine(fileName: string | null | undefined, bytes: number | null | undefined): string {
  return [fileTypeTag(fileName), formatFileSize(bytes)].filter(Boolean).join(" · ")
}

/**
 * Whether the API said media `mediaId` no longer exists (`media_missing`, #423): the media
 * was deleted, as opposed to a lookup that failed (then the doc has neither `media` nor
 * `media_missing` for it, and an image still renders from its `src`). The public page
 * leaves such a block out, with its caption.
 */
export function isMediaMissing(doc: unknown, mediaId: unknown): boolean {
  const missing = (doc as { media_missing?: unknown } | null)?.media_missing
  if (!Array.isArray(missing)) return false
  const id = typeof mediaId === "number" ? mediaId : typeof mediaId === "string" && /^\d+$/.test(mediaId) ? Number(mediaId) : NaN
  return Number.isFinite(id) && missing.some((entry) => entry === id)
}
