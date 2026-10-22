import { createContext } from "react"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { safeImageSrc } from "./safeUrl"

// Image variants and focal point on the public site (#255).
//
// The API adds a "media" map to published docs (api/post_block_media.go):
// for each image block's mediaId, the original's size, its resized variants
// and its focal point. It is derived when the doc is served, never stored.

export interface BlockMediaVariant {
  path: string
  width: number
  height: number
}

export interface BlockMedia {
  media_path: string
  width: number
  height: number
  variants?: Record<string, BlockMediaVariant>
  focal_point?: { x: number; y: number } | null
}

// Default `sizes` for block images: a content column up to ~1000px wide.
// Layouts that know better pass `imageSizes` to BlockRenderer (a narrow text
// column, or "100vw" for full-width layouts), which reaches ImageBlock through
// ImageSizesContext. Erring wide only costs a larger download; erring narrow
// makes the browser pick a variant smaller than the rendered image.
export const BLOCK_IMAGE_SIZES = "(max-width: 1000px) 100vw, 1000px"

export const ImageSizesContext = createContext<string>(BLOCK_IMAGE_SIZES)

export interface ResponsiveImageAttrs {
  src: string
  srcSet?: string
  sizes?: string
  width?: number
  height?: number
  objectPosition?: string
}

// blockMediaFor returns the media info the API attached for an image
// block's mediaId, if any.
export function blockMediaFor(doc: BlockDocV1, mediaId: unknown): BlockMedia | undefined {
  const id = typeof mediaId === "number" || typeof mediaId === "string" ? String(mediaId) : ""
  if (!id) return undefined
  const media = (doc as BlockDocV1 & { media?: Record<string, BlockMedia> }).media
  const entry = media?.[id]
  return entry && typeof entry === "object" ? entry : undefined
}

// toUrl turns a media_path-style path into a site URL ("/uploads/..."), like
// the admin's getMediaURL, then runs it through the same scheme check as
// every other image src.
function toUrl(path: string): string | undefined {
  // Check the scheme first: prefixing "/" would turn "javascript:x" into a
  // relative path instead of rejecting it.
  if (!path || !safeImageSrc(path)) return undefined
  if (/^https?:/i.test(path) || path.startsWith("/")) return path
  // media_path is relative to the API's working directory ("./uploads/...").
  return `/${path.replace(/^(\.\/)+/, "")}`
}

// A srcset candidate URL can't contain whitespace or commas (they separate
// candidates); skip any that do rather than emit a broken attribute.
const srcsetSafe = (url: string | undefined): url is string => !!url && !/[\s,]/.test(url)

const clamp01 = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null)

// pathOf strips the query and hash, so URLs compare by path (an admin preview may carry
// ?v=...).
const pathOf = (url: string) => url.split(/[?#]/)[0]

// responsiveImageAttrs builds the <img> attributes for an image block: the
// block's own src, plus srcset/sizes from the variants (and the original as
// the largest candidate), the intrinsic size, and object-position from the
// focal point. Without media info it is just the sanitized src, and so it is
// when the src isn't that media's file (a stale src after a replace moved
// legacy media to a new path): mixing the two would show different images
// depending on the viewport.
export function responsiveImageAttrs(
  src: string | undefined,
  media: BlockMedia | undefined,
  sizes: string = BLOCK_IMAGE_SIZES
): ResponsiveImageAttrs {
  const safeSrc = safeImageSrc(src)
  const attrs: ResponsiveImageAttrs = { src: safeSrc }
  if (!media || !safeSrc) return attrs
  const original = toUrl(media.media_path)
  if (!original || pathOf(original) !== pathOf(safeSrc)) return attrs

  const candidates = new Map<number, string>()
  for (const variant of Object.values(media.variants || {})) {
    const url = toUrl(variant?.path)
    if (srcsetSafe(url) && variant.width > 0) candidates.set(variant.width, url)
  }
  if (candidates.size > 0 && media.width > 0 && srcsetSafe(safeSrc)) {
    candidates.set(media.width, safeSrc)
    attrs.srcSet = [...candidates.entries()]
      .sort(([a], [b]) => a - b)
      .map(([w, url]) => `${url} ${w}w`)
      .join(", ")
    attrs.sizes = sizes
  }

  if (media.width > 0 && media.height > 0) {
    attrs.width = media.width
    attrs.height = media.height
  }

  const x = clamp01(media.focal_point?.x)
  const y = clamp01(media.focal_point?.y)
  if (x !== null && y !== null) {
    attrs.objectPosition = `${round(x * 100)}% ${round(y * 100)}%`
  }
  return attrs
}

const round = (v: number) => Math.round(v * 10) / 10

// isFirstImageBlock reports whether blockId is the first top-level image in
// the doc. That image is often the largest thing above the fold, so it loads
// eagerly; later ones are lazy.
export function isFirstImageBlock(doc: BlockDocV1, blockId: string): boolean {
  const blocks = doc.blocks as Record<string, { type?: string } | undefined>
  const first = (doc.blocks_order || []).find((id) => blocks[id]?.type === "image")
  return first === blockId
}
