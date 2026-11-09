// The layout blocks' shared rules (#426, design `docs/design/block-library.md` 2.2, 4):
// columns and column (containers, `nesting.ts`), buttons and spacer (flow). The editor, the
// bridge, the validators, the public renderer and the history read them from here; the API
// has the same rules (`api/post_blocks_layout.go`), and `buttonHrefVectors.json` pins the
// href check on both sides. Plain data and functions: no ProseMirror, Yjs or Zod.

import { CONTAINERS } from "./nesting"

// ── Columns ──────────────────────────────────────────────────────────────────────────

/** A columns block holds this many columns (the nesting table's row). */
export const COLUMNS_MIN: number = CONTAINERS.columns.min
export const COLUMNS_MAX: number = CONTAINERS.columns.max

/**
 * How the widths are shared. `50-50`, `33-67` and `67-33` only mean something with exactly
 * two columns; with three or four every column is equal (`equal`, which is also what an
 * unknown value reads as: `columnsLayoutFor`).
 */
export const COLUMNS_LAYOUTS = ["50-50", "33-67", "67-33", "equal"] as const
export type ColumnsLayout = (typeof COLUMNS_LAYOUTS)[number]
export const DEFAULT_COLUMNS_LAYOUT: ColumnsLayout = "equal"
/** The layouts that split two columns (the settings' Layout field). */
export const TWO_COLUMN_LAYOUTS = ["50-50", "33-67", "67-33"] as const satisfies readonly ColumnsLayout[]

/** The labels the picker, the settings and the history show. */
export const COLUMNS_LAYOUT_LABELS: Record<ColumnsLayout, string> = {
  "50-50": "50 / 50",
  "33-67": "33 / 67",
  "67-33": "67 / 33",
  equal: "Equal",
}

export function isColumnsLayout(value: unknown): value is ColumnsLayout {
  return typeof value === "string" && (COLUMNS_LAYOUTS as readonly string[]).includes(value)
}

/**
 * The layout a columns block with `count` columns renders with: its own for two columns,
 * `equal` for any other count (two people, one picking 33 / 67 while the other adds a third
 * column, leave both in the doc) and for a value that isn't one.
 */
export function columnsLayoutFor(layout: unknown, count: number): ColumnsLayout {
  return count === 2 && isColumnsLayout(layout) ? layout : DEFAULT_COLUMNS_LAYOUT
}

/** Each column's share of the row (0..1), in order: what the public page's image `sizes` are from. */
export function columnWidths(layout: ColumnsLayout, count: number): number[] {
  if (count === 2 && layout === "33-67") return [1 / 3, 2 / 3]
  if (count === 2 && layout === "67-33") return [2 / 3, 1 / 3]
  return Array.from({ length: count }, () => 1 / Math.max(count, 1))
}

// ── Buttons ──────────────────────────────────────────────────────────────────────────

export const BUTTON_VARIANTS = ["primary", "secondary"] as const
export type ButtonVariant = (typeof BUTTON_VARIANTS)[number]
export const DEFAULT_BUTTON_VARIANT: ButtonVariant = "primary"

export const BUTTONS_ALIGNS = ["left", "center"] as const
export type ButtonsAlign = (typeof BUTTONS_ALIGNS)[number]
export const DEFAULT_BUTTONS_ALIGN: ButtonsAlign = "left"

/** The longest href and label stored, here and in the API (`buttonHrefMaxLength`, `buttonLabelMaxRunes`). */
export const BUTTON_HREF_MAX_LENGTH = 2048
export const BUTTON_LABEL_MAX_LENGTH = 200

export function isButtonVariant(value: unknown): value is ButtonVariant {
  return typeof value === "string" && (BUTTON_VARIANTS as readonly string[]).includes(value)
}

export function isButtonsAlign(value: unknown): value is ButtonsAlign {
  return typeof value === "string" && (BUTTONS_ALIGNS as readonly string[]).includes(value)
}

const SAFE_BUTTON_SCHEMES = new Set(["http", "https", "mailto", "tel"])

/**
 * A button's href as stored, or null for none: empty, or anything the API's
 * `isSafeURL(href, safeHrefSchemes)` would refuse (`buttonHrefVectors.json` pins that the two
 * agree). Only http(s), mailto, tel and relative URLs; a control character (`java\tscript:`,
 * which browsers strip) is refused. A button's href is a node attr, so ProseMirror's link
 * validation doesn't cover it.
 */
export function normalizeButtonHref(value: unknown): string | null {
  if (typeof value !== "string") return null
  const href = value.trim()
  if (href === "" || href.length > BUTTON_HREF_MAX_LENGTH) return null
  if (/[\u0000-\u001f\u007f]/.test(href)) return null
  // A bad percent escape outside the query: Go's url.Parse refuses it.
  if (/%(?![0-9a-fA-F]{2})/.test(href.split("?")[0])) return null
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href)?.[1].toLowerCase()
  if (scheme !== undefined) {
    if (!SAFE_BUTTON_SCHEMES.has(scheme)) return null
    if (scheme === "http" || scheme === "https") {
      try {
        new URL(href)
      } catch {
        return null
      }
    }
    return href
  }
  // No scheme, but a colon in the first path segment ("1foo:bar"): Go's url.Parse refuses it.
  if (href.split(/[/?#]/)[0].includes(":")) return null
  return href
}

/** What the Link field says for a value it can't use. */
export const BUTTON_HREF_ERROR = "Use a web address, a mailto: or tel: link, or a path on this site like /about."

/**
 * What the Link field typed means, as links are validated in the editor: "" clears the
 * link, a bare domain gets `https://` (the link dialog's rule, `normalizeUrl`), and anything
 * `normalizeButtonHref` refuses is an error (`javascript:` and every other scheme).
 */
export function buttonHrefFromInput(value: string): { href: string | null } | { error: string } {
  const typed = value.trim()
  if (typed === "") return { href: null }
  const withScheme = /^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(typed) && !typed.includes(":") ? `https://${typed}` : typed
  const href = normalizeButtonHref(withScheme)
  return href === null ? { error: BUTTON_HREF_ERROR } : { href }
}

/** A button's label as stored: control characters as spaces, trimmed, capped. */
export function normalizeButtonLabel(value: unknown): string {
  if (typeof value !== "string") return ""
  const clean = value.replace(/\p{Cc}/gu, " ").trim()
  const points = [...clean]
  return points.length > BUTTON_LABEL_MAX_LENGTH ? points.slice(0, BUTTON_LABEL_MAX_LENGTH).join("").trim() : clean
}

// ── Spacer ───────────────────────────────────────────────────────────────────────────

/**
 * A spacer's heights: steps of the theme's spacing scale (`--space-5` … `--space-9`), never
 * pixels, so a theme with a different scale changes them all at once. The px are the
 * default theme's (`themes/default/theme.config.ts`, `spacing`; checked by
 * `themes/default/layoutBlocks.test.ts`): what the editor's label says, and the fallback for
 * a theme that doesn't define the custom property.
 */
export const SPACER_STEPS = [
  { size: "5", px: 24 },
  { size: "7", px: 48 },
  { size: "8", px: 64 },
  { size: "9", px: 96 },
] as const
export type SpacerSize = (typeof SPACER_STEPS)[number]["size"]
export const SPACER_SIZES = SPACER_STEPS.map((step) => step.size) as [SpacerSize, ...SpacerSize[]]
/** A new spacer's height (the canvas: "A new spacer starts at 48 px"). */
export const DEFAULT_SPACER_SIZE: SpacerSize = "7"

export function isSpacerSize(value: unknown): value is SpacerSize {
  return typeof value === "string" && (SPACER_SIZES as readonly string[]).includes(value)
}

/** A stored, typed or pasted size as the scale has it; anything else is the default. */
export function normalizeSpacerSize(value: unknown): SpacerSize {
  return isSpacerSize(value) ? value : DEFAULT_SPACER_SIZE
}

/** The step's height in the default theme, in px (the editor's "48 px"). */
export function spacerPx(size: unknown): number {
  const wanted = normalizeSpacerSize(size)
  return SPACER_STEPS.find((step) => step.size === wanted)!.px
}

/** The step's height as CSS: the active theme's scale, the default's px without one. */
export function spacerHeight(size: unknown): string {
  const wanted = normalizeSpacerSize(size)
  return `var(--space-${wanted}, ${spacerPx(wanted)}px)`
}

/** The next step up (1) or down (-1), or the same one at the end of the scale. */
export function stepSpacerSize(size: unknown, dir: -1 | 1): SpacerSize {
  const at = SPACER_SIZES.indexOf(normalizeSpacerSize(size))
  return SPACER_SIZES[Math.min(SPACER_SIZES.length - 1, Math.max(0, at + dir))]
}

/** The step nearest `px`, for dragging the handle. */
export function nearestSpacerSize(px: number): SpacerSize {
  return SPACER_STEPS.reduce((best, step) => (Math.abs(step.px - px) < Math.abs(best.px - px) ? step : best)).size
}
