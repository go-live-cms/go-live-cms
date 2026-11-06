import { normalizeBlockColor } from "@gl-admin/lib/blocks-spec"

/**
 * The class a block colour (#356) renders as: `gl-color-red`, `gl-color-red-background`.
 * Every theme in `themes/` styles each one in light and dark (`blockColors.test.ts`).
 * Undefined for no colour and for anything outside the palette, so a stored value can
 * never become an arbitrary class or style.
 */
export function blockColorClass(value: unknown): string | undefined {
  const color = normalizeBlockColor(value)
  return color ? `gl-color-${color}` : undefined
}

/** `attrs.blockColor` of a stored block, as its class. */
export function blockColorClassOf(attrs: unknown): string | undefined {
  return blockColorClass((attrs as { blockColor?: unknown } | null | undefined)?.blockColor)
}

/** Space-joined class names, undefined when there are none (no empty `class=""`). */
export function classNames(...names: (string | undefined | null | false)[]): string | undefined {
  const joined = names.filter(Boolean).join(" ")
  return joined || undefined
}
