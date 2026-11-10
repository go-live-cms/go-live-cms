import { focalPosition, isBlockDecorative, isMediaMissing, normalizeFocal, type BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { blockFileFor } from "./mediaFile"
import { isFirstImageBlock, responsiveImageAttrs, type ResponsiveImageAttrs } from "./responsiveImage"

// The image of a cover or media & text (#427). They store only a media id, so the URL,
// variants and size come from the `media` map the API attaches to a served doc, the same place
// the video, audio and file blocks read theirs, and the URL is only ever under /uploads. The
// focal point is the block's own, else the media's.

export interface ContainerImage {
  /** Null when the lookup failed: the block's blocks still render, without the picture. */
  image: ResponsiveImageAttrs | null
  alt: string
  eager: boolean
}

/**
 * What a cover or media & text renders, or null when it renders nothing: no image chosen
 * yet, or the media was deleted (`media_missing`: "left out until the file is replaced"). A lookup
 * that failed leaves `image` null and the block stays, so a blip never costs its text.
 */
export function containerImageFor(doc: BlockDocV1, block: { id: string; type: "cover" | "media_text"; attrs: unknown }, sizes: string): ContainerImage | null {
  const attrs = (block.attrs ?? {}) as Record<string, unknown>
  if (attrs.mediaId === undefined || attrs.mediaId === null || isMediaMissing(doc, attrs.mediaId)) return null
  const eager = isFirstImageBlock(doc, block.id)
  const file = blockFileFor(doc, attrs.mediaId)
  if (!file) return { image: null, alt: "", eager }
  const image = responsiveImageAttrs(file.url, file.media, sizes)
  const focal = normalizeFocal(attrs.focal)
  if (focal) image.objectPosition = focalPosition(focal)
  const decorative = isBlockDecorative(block.type, attrs.decorative) || file.media.decorative === true
  return { image, alt: decorative || typeof attrs.alt !== "string" ? "" : attrs.alt, eager }
}
