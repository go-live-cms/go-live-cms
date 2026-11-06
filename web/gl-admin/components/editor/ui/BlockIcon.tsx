import type { BlockIconSpec, CatalogEntry } from "../blocks/catalog"
import type { CommandSelectOption } from "./CommandSelect"

// A block catalog icon (#415): the design's 24×24 stroke path, or a text glyph ("H1").
// Always decorative: the block's name is next to it.
export function BlockIcon({ icon, size = 14 }: { icon: BlockIconSpec; size?: number }) {
  if (icon.glyph !== undefined) return <>{icon.glyph}</>
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={icon.path} />
    </svg>
  )
}

/** Catalog entries as a CommandSelect's options (Turn into, the block-type toolbar). */
export function catalogSelectOptions(entries: readonly CatalogEntry[]): CommandSelectOption[] {
  return entries.map((entry) => ({ value: entry.id, label: entry.name, label_icon: <BlockIcon icon={entry.icon} /> }))
}
