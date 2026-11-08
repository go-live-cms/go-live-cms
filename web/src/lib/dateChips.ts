import { chipDateInstant, dateChipAttrs, formatChipTime, DATE_CHIP_NODE, type DateChipAttrs } from "@gl-admin/lib/blocks-spec/inlineNodes"
import { formatSiteDate, DEFAULT_DATE_SETTINGS, type DateSettings, type DateStyle } from "./siteDates"

// Date chips (#320, blocks-spec/inlineNodes.ts) as the site and the editor show them: the
// day in the site's language and date format, plus the time when the chip has one. The
// chip stores a calendar day, so it is formatted as that day wherever the reader is (UTC
// at noon), never shifted by a time zone.

/** "Nov 12, 2026" / "12 Nov 2026" / "2026-11-12", with ", 2:30 PM" for a chip with a time. */
export function formatDateChip(attrs: DateChipAttrs, settings: DateSettings = DEFAULT_DATE_SETTINGS, style: DateStyle = "short"): string {
  const day = formatSiteDate(chipDateInstant(attrs.date), { ...settings, timeZone: "UTC" }, style)
  return attrs.time ? `${day}, ${formatChipTime(attrs.time, settings.language)}` : day
}

/** The chip's `datetime` attribute: the day, or the day and the time (site time, no zone). */
export function dateChipDateTime(attrs: DateChipAttrs): string {
  return attrs.time ? `${attrs.date}T${attrs.time}` : attrs.date
}

interface PMJSONNode {
  type?: string
  attrs?: Record<string, unknown>
  content?: PMJSONNode[]
}

function labelChips(node: PMJSONNode, settings: DateSettings): void {
  if (!node || typeof node !== "object") return
  if (node.type === DATE_CHIP_NODE) {
    const attrs = dateChipAttrs(node.attrs)
    if (attrs) node.attrs = { ...node.attrs, label: formatDateChip(attrs, settings, "long") }
  }
  if (Array.isArray(node.content)) node.content.forEach((child) => labelChips(child, settings))
}

/**
 * Gives every date chip in a published block doc its `label` in the site's format, before
 * the theme renders it (`PostPage.astro`): the renderer has no site settings of its own.
 * Mutates and returns `doc` (the page's own copy from the API).
 */
export function labelDateChips<T>(doc: T, settings: DateSettings): T {
  const blocks = (doc as { blocks?: Record<string, { attrs?: { pm?: PMJSONNode } }> } | null)?.blocks
  if (!blocks || typeof blocks !== "object") return doc
  for (const block of Object.values(blocks)) {
    const pm = block?.attrs?.pm
    if (pm) labelChips(pm, settings)
  }
  return doc
}
