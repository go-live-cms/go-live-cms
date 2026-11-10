// Cover and media & text (#427, design `docs/design/block-library.md` 2.2, 3.4, 4): two
// containers that show one image from the media library beside or behind their blocks. The
// editor, the bridge, the validators, the public renderer and the history read these rules;
// the API has the same ones (`api/post_blocks_cover.go`), and `coverMediaVectors.json` pins
// the numbers on both sides. Plain data and functions: no ProseMirror, Yjs or Zod.

export const COVER_BLOCK_VERSION = 1
export const MEDIA_TEXT_BLOCK_VERSION = 1

/** The ProseMirror nodes of the two blocks (`mediaId`, `alt`, `decorative`, `focalX`, `focalY`). */
export const COVER_MEDIA_NODE_NAMES = ["cover", "mediaText"] as const
export type CoverMediaNodeName = (typeof COVER_MEDIA_NODE_NAMES)[number]

export function isCoverMediaNode(name: unknown): name is CoverMediaNodeName {
  return name === "cover" || name === "mediaText"
}

// ── Overlay ──────────────────────────────────────────────────────────────────────────

export const COVER_OVERLAY_MIN = 0
export const COVER_OVERLAY_MAX = 80
export const COVER_OVERLAY_STEP = 5
/**
 * The overlay a new cover starts with, as drawn. It is also the lowest step at which white
 * text keeps 4.5:1 over a pure white image with no help (`themes/default/coverBlocks.test.ts`).
 */
export const COVER_OVERLAY_DEFAULT = 55

/** A number clamped to 0–80 and snapped to its step of 5, the API's `sanitizeCoverAttrs`; else the default. */
export function normalizeCoverOverlay(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return COVER_OVERLAY_DEFAULT
  const clamped = Math.min(COVER_OVERLAY_MAX, Math.max(COVER_OVERLAY_MIN, value))
  return Math.round(clamped / COVER_OVERLAY_STEP) * COVER_OVERLAY_STEP
}

/** How far a cover spreads (the same three as a group; `content` is left out when stored). */
export const COVER_ALIGNS = ["content", "wide", "full"] as const
export type CoverAlign = (typeof COVER_ALIGNS)[number]

export function isCoverAlign(value: unknown): value is CoverAlign {
  return typeof value === "string" && (COVER_ALIGNS as readonly string[]).includes(value)
}

/** Where a media & text block's media sits on wide screens (`left` is left out when stored). */
export const MEDIA_TEXT_POSITIONS = ["left", "right"] as const
export type MediaTextPosition = (typeof MEDIA_TEXT_POSITIONS)[number]

export function isMediaTextPosition(value: unknown): value is MediaTextPosition {
  return typeof value === "string" && (MEDIA_TEXT_POSITIONS as readonly string[]).includes(value)
}

// ── Alt text ─────────────────────────────────────────────────────────────────────────

/** Longest alt text, in code points: what the media library's own field takes (`max=255`). */
export const MEDIA_ALT_MAX_LENGTH = 255

/** At most MEDIA_ALT_MAX_LENGTH code points (a field's maxLength counts UTF-16 units). */
export function capMediaAlt(value: string): string {
  const points = [...value]
  return points.length > MEDIA_ALT_MAX_LENGTH ? points.slice(0, MEDIA_ALT_MAX_LENGTH).join("") : value
}

/** Alt text as stored, as the API's sanitizer makes it: control characters as spaces, trimmed, capped, null when empty. */
export function normalizeMediaAlt(value: unknown): string | null {
  if (typeof value !== "string") return null
  const alt = capMediaAlt(value.replace(/\p{Cc}/gu, " ").trim()).trim()
  return alt === "" ? null : alt
}

/**
 * Whether the image is announced: a cover is decorative unless it says otherwise (its text
 * carries the meaning, as drawn), media & text is not.
 */
export function isBlockDecorative(type: "cover" | "media_text", value: unknown): boolean {
  if (typeof value === "boolean") return value
  return type === "cover"
}

/**
 * Whether the block is flagged "No alt text" (#325): it says nothing about its image, and
 * neither the block nor the media is marked decorative. A flag never shows on the public page.
 */
export function needsAltText(alt: unknown, decorative: boolean, mediaDecorative: boolean): boolean {
  return !decorative && !mediaDecorative && normalizeMediaAlt(alt) === null
}

// ── Focal point ──────────────────────────────────────────────────────────────────────

/**
 * A block's own focal point, in whole percent from the top left. The block has one only when
 * someone moved it; otherwise it follows the media's `focal_point` (fractions 0..1), so a
 * change there reaches the block without republishing.
 */
export interface FocalPercent {
  x: number
  y: number
}

/** One axis: a finite number clamped to 0–100 and rounded; anything else is null. */
export function normalizeFocalAxis(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  return Math.round(Math.min(100, Math.max(0, value)))
}

/** Both axes or neither (Block Spec's `focal`, the node's `focalX` and `focalY`). */
export function normalizeFocal(value: unknown): FocalPercent | null {
  const point = value as { x?: unknown; y?: unknown } | null | undefined
  const x = normalizeFocalAxis(point?.x)
  const y = normalizeFocalAxis(point?.y)
  return x === null || y === null ? null : { x, y }
}

/** A focal point from the media library's fractions, for showing and starting from. */
export function focalFromMedia(point: { x?: unknown; y?: unknown } | null | undefined): FocalPercent {
  const axis = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? (normalizeFocalAxis(value * 100) as number) : 50)
  return { x: axis(point?.x), y: axis(point?.y) }
}

/** Where an arrow key puts the point ("Keyboard" › Focal point): 1%, or 10% with Shift; null for any other key. */
export function moveFocal(focal: FocalPercent, key: string, shift: boolean): FocalPercent | null {
  const step = shift ? 10 : 1
  const clamp = (value: number) => Math.min(100, Math.max(0, value))
  switch (key) {
    case "ArrowLeft":
      return { ...focal, x: clamp(focal.x - step) }
    case "ArrowRight":
      return { ...focal, x: clamp(focal.x + step) }
    case "ArrowUp":
      return { ...focal, y: clamp(focal.y - step) }
    case "ArrowDown":
      return { ...focal, y: clamp(focal.y + step) }
    default:
      return null
  }
}

/** The value of `object-position`. */
export function focalPosition(focal: FocalPercent): string {
  return `${focal.x}% ${focal.y}%`
}

/** The stored shape of a `focal` read back from a node's two scalar attrs. */
export function focalOfNodeAttrs(attrs: { focalX?: unknown; focalY?: unknown }): FocalPercent | null {
  return normalizeFocal({ x: attrs.focalX, y: attrs.focalY })
}

// ── Node attrs ⇄ Block Spec ──────────────────────────────────────────────────────────

/** The attrs a stored block and its node have in common. `mediaId` is the bridge's, like the other media blocks'. */
interface SharedStored {
  alt?: string
  decorative: boolean
  focal?: FocalPercent
}

type NodeAttrs = Record<string, unknown>

function sharedStored(type: "cover" | "media_text", attrs: NodeAttrs): SharedStored {
  const alt = normalizeMediaAlt(attrs.alt)
  const focal = focalOfNodeAttrs(attrs)
  return { ...(alt ? { alt } : {}), decorative: isBlockDecorative(type, attrs.decorative), ...(focal ? { focal } : {}) }
}

function sharedNode(type: "cover" | "media_text", stored: NodeAttrs): NodeAttrs {
  const alt = normalizeMediaAlt(stored.alt)
  const focal = normalizeFocal(stored.focal)
  return {
    ...(alt ? { alt } : {}),
    decorative: isBlockDecorative(type, stored.decorative),
    ...(focal ? { focalX: focal.x, focalY: focal.y } : {}),
  }
}

/** A cover node's attrs as Block Spec stores them: `decorative` and `overlay` always, the rest when set. */
export function coverStoredAttrs(attrs: NodeAttrs) {
  return {
    ...sharedStored("cover", attrs),
    overlay: normalizeCoverOverlay(attrs.overlay),
    ...(isCoverAlign(attrs.align) && attrs.align !== "content" ? { align: attrs.align } : {}),
  }
}

/** A stored cover's attrs for its node. */
export function coverNodeAttrs(stored: NodeAttrs): NodeAttrs {
  return {
    ...sharedNode("cover", stored),
    overlay: normalizeCoverOverlay(stored.overlay),
    ...(isCoverAlign(stored.align) ? { align: stored.align } : {}),
  }
}

/** A media & text node's attrs as Block Spec stores them. */
export function mediaTextStoredAttrs(attrs: NodeAttrs) {
  return {
    ...sharedStored("media_text", attrs),
    ...(isMediaTextPosition(attrs.position) && attrs.position !== "left" ? { position: attrs.position } : {}),
  }
}

/** A stored media & text block's attrs for its node. */
export function mediaTextNodeAttrs(stored: NodeAttrs): NodeAttrs {
  return {
    ...sharedNode("media_text", stored),
    ...(isMediaTextPosition(stored.position) ? { position: stored.position } : {}),
  }
}
