import { isMediaMissing } from "@gl-admin/lib/blocks-spec"
import { blockMediaFor, type BlockMedia } from "./responsiveImage"

// The video, audio and file blocks (#423) store only a media id. Their file comes from the
// `media` map the API attaches to a served doc (api/post_block_media.go): its URL, type,
// size and names. Nothing in the stored block can point a reader anywhere else.

/**
 * `path` when it is a file under the site's `/uploads` (the only place the public site
 * serves media from: the API's `publicMediaPath`), else undefined. No scheme, host, query,
 * `..` segment, backslash or whitespace gets through.
 */
export function uploadsUrl(path: unknown): string | undefined {
  if (typeof path !== "string" || !/^\/uploads\/[^\s?#\\]+$/.test(path)) return undefined
  return path.split("/").some((segment) => segment === ".." || segment === ".") ? undefined : path
}

export interface BlockFile {
  /** The file's URL, always under /uploads. */
  url: string
  media: BlockMedia
}

/**
 * The file a video, audio or file block shows, or null when the block renders nothing:
 * no file chosen yet, the media was deleted (`media_missing`: left out, caption and all),
 * or the API couldn't look it up (no entry: there is no URL to render).
 */
export function blockFileFor(doc: unknown, mediaId: unknown): BlockFile | null {
  if (mediaId === undefined || mediaId === null || isMediaMissing(doc, mediaId)) return null
  const media = blockMediaFor(doc as Parameters<typeof blockMediaFor>[0], mediaId)
  const url = uploadsUrl(media?.media_path)
  return media && url ? { url, media } : null
}

/**
 * The name a download is saved as: the uploaded file's own name (the stored one is
 * random, #399), without path separators or control characters; undefined lets the
 * browser use the URL's.
 */
export function downloadName(media: BlockMedia): string | undefined {
  const name = (media.filename ?? "").replace(/[\p{Cc}/\\]/gu, "").trim()
  return name || undefined
}

export interface BlockTrack {
  /** The WebVTT file's URL, always under /uploads. */
  url: string
  /** The track's srclang; undefined when the API sent none or an odd one. */
  lang?: string
  /** The track's label in the player's captions menu (never empty). */
  label: string
}

// A BCP-47 tag in the shape the API accepts (`captionsLangPattern`, #507).
const TRACK_LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/

/**
 * A video's captions track (#507), from its block media entry's `captions` (the API adds
 * them from the media item's WebVTT file), or null when there are none or the URL isn't a
 * file under /uploads.
 */
export function blockCaptionsFor(media: BlockMedia): BlockTrack | null {
  const captions = media.captions
  if (!captions || typeof captions !== "object") return null
  const url = uploadsUrl(captions.url)
  if (!url) return null
  const lang = typeof captions.lang === "string" && TRACK_LANG.test(captions.lang) ? captions.lang : undefined
  const label = (typeof captions.label === "string" ? captions.label.trim() : "") || lang || "Captions"
  return { url, lang, label }
}