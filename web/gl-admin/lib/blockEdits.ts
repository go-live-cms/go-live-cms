import { formatLastEdited } from "./contentList"
import { personName } from "./activityFeed"
import type { BlockEditsSnapshot } from "./blockEditsStore"

// The block menu's "Last edited by" line (#328, "Editor menus & states" › Block menu).

/** Who's shown for an edit by a member removed since (or one this tab can't name). */
export const FORMER_MEMBER = "a former member"

/**
 * "Last edited by Ana Costa · 2 hours ago", "Last edited by you · just now", "Last edited by
 * a former member · Oct 24", or null when the block has no attribution (never edited since
 * #328 shipped, from a duplicate or a template, or not stored yet).
 */
export function lastEditedLine(
  snapshot: BlockEditsSnapshot,
  blockId: string | null | undefined,
  viewerId: number | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!blockId) return null
  const entry = snapshot.edits.get(blockId)
  if (!entry) return null
  const when = formatLastEdited(entry.editedAt, now)
  if (!when) return null
  const known = entry.userId !== null ? snapshot.users.get(entry.userId) : undefined
  // A user this tab hasn't loaded yet (the store is reading their name): no line until
  // it knows, rather than calling a current member a former one.
  if (entry.userId !== null && entry.userId !== viewerId && !known) return null
  const who = entry.userId !== null && entry.userId === viewerId ? "you" : personName(known) || FORMER_MEMBER
  return `Last edited by ${who} · ${/^(Just|Yesterday)/.test(when) ? when.toLowerCase() : when}`
}
