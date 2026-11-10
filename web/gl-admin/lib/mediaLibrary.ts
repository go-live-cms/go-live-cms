import type { FocalPoint, Media, MediaSortOption } from "@gl-admin/lib/types"
import { formatFileSize as formatBlockFileSize } from "./blocks-spec/media"

// The media library's rules (#342): file kinds and their tags, the line under a tile,
// the type filter, and the "Used in" rows. Kept out of the components so they're tested
// on their own (mediaLibrary.test.ts).

export type MediaKind = "image" | "vector" | "video" | "audio" | "file"

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"]

export function fileExtension(path: string): string {
  const name = path.split("/").pop() ?? ""
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
}

// The kind decides the tile's icon and tag colour. The MIME type wins; the extension
// covers rows saved without one.
export function mediaKind(media: Pick<Media, "media_path" | "mime_type">): MediaKind {
  const mime = media.mime_type || ""
  const ext = fileExtension(media.media_path)
  if (mime === "image/svg+xml" || ext === "svg") return "vector"
  if (mime.startsWith("image/") || IMAGE_EXTENSIONS.includes(ext)) return "image"
  if (mime.startsWith("video/")) return "video"
  if (mime.startsWith("audio/")) return "audio"
  return "file"
}

// Raster images get a preview (and variants, focal point and crop previews); SVGs are
// shown as an icon, like before, since the API makes no variants of them.
export function isRasterImage(media: Pick<Media, "media_path" | "mime_type">): boolean {
  return mediaKind(media) === "image"
}

// Alt text applies to images, SVGs included (the fields show for both).
export function hasAltText(media: Pick<Media, "media_path" | "mime_type">): boolean {
  const kind = mediaKind(media)
  return kind === "image" || kind === "vector"
}

// Missing alt text (#325), exactly the API's rule for GET /media?missing_alt=true and the
// Home count: an image/* MIME type (no extension fallback, or a tile could be tagged and
// still be left out of the filter), not decorative, alt empty or only whitespace.
export function missingAlt(media: Pick<Media, "mime_type" | "alt" | "decorative">): boolean {
  return (media.mime_type || "").startsWith("image/") && !media.decorative && !(media.alt ?? "").trim()
}

// The hint under the alt text field.
export function altHint(decorative: boolean): string {
  return decorative
    ? "Not used while the image is marked decorative."
    : "Describe what the image shows, for people who can't see it."
}

// The alt text as read-only views show it.
export function altTextValue(media: Pick<Media, "alt" | "decorative">): string {
  if (media.decorative) return "None, decorative image"
  return media.alt?.trim() || "None"
}

// The "Missing alt text" filter, ?alt=missing in the library's URL.
export const MISSING_ALT_PARAM = { name: "alt", value: "missing" } as const

// The tag in a tile's corner: the file format ("JPG", "PDF").
export function formatTag(media: Pick<Media, "media_path">): string {
  return fileExtension(media.media_path).toUpperCase() || "FILE"
}

// 412 KB, 1.4 MB (the media blocks' formatter, #423), "0 B" for none.
export function formatFileSize(bytes: number | null | undefined): string {
  return formatBlockFileSize(bytes) || "0 B"
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return ""
  const s = Math.round(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

export function formatDimensions(media: Pick<Media, "width" | "height">): string {
  return media.width && media.height ? `${media.width} × ${media.height}` : ""
}

// The line under a tile's name: "2400 × 1500 · 412 KB", or just the size.
export function mediaMetaLine(media: Pick<Media, "width" | "height" | "file_size">): string {
  return [formatDimensions(media), formatFileSize(media.file_size)].filter(Boolean).join(" · ")
}

// "PNG image", "MP4 video", "PDF file" (the panel's Type row).
export function typeLabel(media: Pick<Media, "media_path" | "mime_type">): string {
  const noun = { image: "image", vector: "image", video: "video", audio: "audio", file: "file" }[mediaKind(media)]
  return `${formatTag(media)} ${noun}`
}

// The type filter (the API's `type` values). "Files" is everything under application/.
export const TYPE_FILTERS: { id: string; label: string }[] = [
  { id: "", label: "All" },
  { id: "image", label: "Images" },
  { id: "video", label: "Video" },
  { id: "audio", label: "Audio" },
  { id: "document", label: "Files" },
]

export const MEDIA_SORTS: { value: MediaSortOption; label: string }[] = [
  { value: "date_desc", label: "Newest" },
  { value: "date_asc", label: "Oldest" },
  { value: "name_asc", label: "Name A–Z" },
  { value: "name_desc", label: "Name Z–A" },
  { value: "size_desc", label: "Largest" },
  { value: "size_asc", label: "Smallest" },
]

export function findMediaSort(value: string | null): MediaSortOption {
  return MEDIA_SORTS.find((s) => s.value === value)?.value ?? "date_desc"
}

// "214 files", or "No files yet" for an empty library.
export function countLine(total: number): string {
  if (total === 0) return "No files yet"
  return `${total} ${total === 1 ? "file" : "files"}`
}

// CSS object-position for a focal point, the same rounding as the public ImageBlock
// (src/components/blocks/utils/responsiveImage.ts), so the crop previews show what the
// site will do. Unset is the center, like the browser's default.
export function focalObjectPosition(point: FocalPoint | null | undefined): string {
  if (!point) return "50% 50%"
  const round = (v: number) => Math.round(v * 10) / 10
  return `${round(point.x * 100)}% ${round(point.y * 100)}%`
}

// The crop previews under the focal point picker: common theme aspect ratios.
export const CROP_PREVIEWS = [
  { label: "Wide 16:9", width: 176, height: 99 },
  { label: "Square", width: 112, height: 112 },
  { label: "Tall 4:5", width: 96, height: 120 },
]

// How a post uses a file (#176): its featured image, a content block showing it
// (`block_id`, `block_type`: "image", "video", "audio", "file" (#423), "cover", "media_text" (#427), or a theme block's
// "theme:<slug>/<block>"), or a
// link made some other way ("attached").
export interface MediaUsage {
  type: "featured" | "block" | "attached"
  block_id?: string
  block_type?: string
}

// One row of GET /media/:id/posts.
export interface MediaPostLink {
  post: { id: number; title: string; post_type: string; post_status: string }
  media_order: number
  relationship_type: string
  // Missing from an API older than #176: relationship_type alone then.
  usages?: MediaUsage[]
}

export interface UsedInRow {
  key: string
  postId: number
  title: string
  // How the post uses it: "Featured image", "Image block", "Featured image and 2 image
  // blocks".
  how: string
  status: string
}

// "image" → "image block", "theme:example/alert" → "alert block".
function blockNoun(blockType: string | undefined): string {
  if (blockType === "media_text") return "media & text block"
  const name = (blockType || "image").split("/").pop()!.replace(/[-_]+/g, " ")
  return `${name.toLowerCase()} block`
}

// The usage phrases of one link, in order, lower case: "featured image", "2 image blocks".
export function usageLabels(link: Pick<MediaPostLink, "relationship_type" | "usages">): string[] {
  if (!link.usages?.length) return [link.relationship_type === "featured" ? "featured image" : "image in the post"]
  const labels: string[] = []
  const blocks = new Map<string, number>()
  for (const usage of link.usages) {
    if (usage.type === "featured") labels.push("featured image")
    else if (usage.type === "block") {
      const noun = blockNoun(usage.block_type)
      blocks.set(noun, (blocks.get(noun) ?? 0) + 1)
    } else labels.push("attached")
  }
  for (const [noun, count] of blocks) labels.push(count === 1 ? noun : `${count} ${noun}s`)
  return labels
}

// The "Used in" list. post_media has one link per post and file: the featured image
// (order 0) and the content links (order > 0, synced by the collab store), each with
// the blocks that show it. An older API could send a post twice; those merge into one
// row.
export function usedInRows(links: MediaPostLink[]): UsedInRow[] {
  const byPost = new Map<number, { link: MediaPostLink; hows: string[] }>()
  for (const link of links) {
    const entry = byPost.get(link.post.id) ?? { link, hows: [] }
    for (const how of usageLabels(link)) {
      if (!entry.hows.includes(how)) entry.hows.push(how)
    }
    byPost.set(link.post.id, entry)
  }
  return [...byPost.values()].map(({ link, hows }) => {
    const type = link.post.post_type && link.post.post_type !== "post" ? `${capitalize(link.post.post_type)} · ` : ""
    return {
      key: String(link.post.id),
      postId: link.post.id,
      title: link.post.title || "Untitled",
      how: type + capitalize(hows.join(" and ")),
      status: link.post.post_status,
    }
  })
}

export function usedInHeading(count: number): string {
  if (count === 0) return "Not used yet"
  return `Used in ${count} ${count === 1 ? "place" : "places"}`
}

// The Replace file line: who will see the new file.
export function replaceHint(count: number | null): string {
  const keep = "Name, description and alt text stay."
  if (!count) return `Posts that use this file will show the new one. ${keep}`
  if (count === 1) return `The 1 place that uses this file will show the new one. ${keep}`
  return `The ${count} places that use this file will show the new one. ${keep}`
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
