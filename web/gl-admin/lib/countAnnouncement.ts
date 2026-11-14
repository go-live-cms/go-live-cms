// What a character counter says to a screen reader (#477, WCAG 4.1.3). The counters
// ("120 / 160") used to be live regions, so every keystroke was read out. Now the visible
// counter is only the field's description (read when the field is focused), and a separate
// live region speaks only near or over the limit, once typing pauses. Pure; tested in
// countAnnouncement.test.ts. The component is components/ui/CountAnnouncer.tsx.

export type CountZone = "under" | "near" | "over"

/** How close is "near": the last 10% of the limit, and never fewer than 10 characters. */
export function nearThreshold(limit: number): number {
  return Math.max(10, Math.ceil(limit * 0.1))
}

export function countZone(count: number, limit: number): CountZone {
  if (count > limit) return "over"
  if (limit - count <= nearThreshold(limit)) return "near"
  return "under"
}

/**
 * The words for `count` of `limit`, or null far from the limit (nothing to say).
 * `overNote` follows the "over" message ("Search results may cut it off.").
 */
export function countAnnouncement(count: number, limit: number, overNote?: string): string | null {
  const zone = countZone(count, limit)
  if (zone === "under") return null
  if (zone === "over") {
    const over = count - limit
    const base = `${over} character${over === 1 ? "" : "s"} over the limit of ${limit}.`
    return overNote ? `${base} ${overNote}` : base
  }
  const left = limit - count
  if (left === 0) return `At the limit of ${limit} characters.`
  return `${left} character${left === 1 ? "" : "s"} left.`
}

/** How long typing must pause before the counter speaks. */
export const COUNT_ANNOUNCE_DELAY_MS = 800
