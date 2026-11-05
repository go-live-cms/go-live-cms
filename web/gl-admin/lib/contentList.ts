import {
  canCreateContent,
  canDeletePostPermanently,
  canEditPost,
  canRestorePost,
  canTrashPost,
  isContentModerator,
  isTrashed,
  type PermissionUser,
} from "@gl-admin/lib/roles"
import type { Post, PostSortField, SortOrder } from "@gl-admin/lib/api/types"
import type { BulkAction } from "@gl-admin/lib/api/posts"

// The posts list's rules (#340), as data so they're testable: which status tabs a role
// gets and their counts, what the signed-in user may do to each row, the sort menu
// and how "last edited" reads. A UI hint only (lib/roles.ts): the API enforces it.

// "All" leaves archived posts out: archiving hides a post from the site and from All.
// Scheduled posts (#147) are in it: they're drafts with a publish time.
export const ACTIVE_STATUSES = "draft,published,scheduled"

export type ListTab = {
  id: string
  label: string
  // The list's status filter: one status, a comma list, or "" for every status.
  status: string
  // Only the signed-in user's own posts (user_id).
  mine?: boolean
  // Only published posts with changes not published (#326, unpublished_changes).
  unpublishedChanges?: boolean
}

// Trash (#327), last: posts moved there, which restore brings back with their old status.
export const TRASH_TAB: ListTab = { id: "trash", label: "Trash", status: "trash" }

// Every status, for lists that load everything and filter themselves (the Pages tree).
export const ALL_STATUSES = "draft,published,scheduled,archived,trash"

// "Changes not published" (#326) is a subset of Published: the publishers' to-do list.
export const MODERATOR_TABS: ListTab[] = [
  { id: "all", label: "All", status: ACTIVE_STATUSES },
  { id: "published", label: "Published", status: "published" },
  { id: "changes", label: "Changes not published", status: "published", unpublishedChanges: true },
  { id: "draft", label: "Drafts", status: "draft" },
  { id: "scheduled", label: "Scheduled", status: "scheduled" },
  { id: "archived", label: "Archived", status: "archived" },
  TRASH_TAB,
]

// Contributors: their own posts at any status, and what's live. Their Trash is their own
// trashed posts (nobody else's is theirs to read). "My posts" (no status) leaves the
// trash out, as the API does.
const CONTRIBUTOR_TABS: ListTab[] = [
  { id: "all", label: "All", status: ACTIVE_STATUSES },
  { id: "mine", label: "My posts", status: "", mine: true },
  { id: "published", label: "Published", status: "published" },
  { ...TRASH_TAB, mine: true },
]

export function listTabs(role: string | null | undefined): ListTab[] {
  return isContentModerator(role) ? MODERATOR_TABS : CONTRIBUTOR_TABS
}

// A tab from the URL (?view=draft), falling back to the first one.
export function findTab(tabs: ListTab[], id: string | null | undefined): ListTab {
  return tabs.find((t) => t.id === id) ?? tabs[0]
}

export type StatusCounts = Record<string, number>

// How many posts a tab lists, from GET /posts/counts. `mine` are the counts for the
// signed-in user's posts, `unpublishedChanges` the response's unpublished_changes (#326).
// null while either is still loading (the tab shows a skeleton).
export function tabCount(
  tab: ListTab,
  counts: StatusCounts | null,
  mine: StatusCounts | null = null,
  unpublishedChanges: number | null = null
): number | null {
  if (tab.unpublishedChanges) return unpublishedChanges
  const source = tab.mine ? mine : counts
  if (!source) return null
  const statuses = tab.status ? tab.status.split(",") : Object.keys(source).filter((s) => s !== "trash")
  return statuses.reduce((sum, s) => sum + (source[s] ?? 0), 0)
}

// Every post of every status: 0 means the site has none yet (the empty state).
export function totalCount(counts: StatusCounts | null): number | null {
  return counts ? Object.values(counts).reduce((a, b) => a + b, 0) : null
}

export type SortOption = { id: string; label: string; sort: PostSortField; order: SortOrder }

// The design's default is "Last edited".
export const SORT_OPTIONS: SortOption[] = [
  { id: "edited", label: "Last edited", sort: "changed_at", order: "desc" },
  { id: "newest", label: "Newest", sort: "created_at", order: "desc" },
  { id: "oldest", label: "Oldest", sort: "created_at", order: "asc" },
  { id: "title", label: "Title A–Z", sort: "title", order: "asc" },
]

export function findSort(id: string | null | undefined): SortOption {
  return SORT_OPTIONS.find((s) => s.id === id) ?? SORT_OPTIONS[0]
}

type ListPost = Pick<Post, "user_id" | "post_status" | "username" | "authors" | "trashed_from_status" | "collaborator">

// The owner's name for "Sofia L. owns it": their byline entry, else posts.username.
export function ownerName(post: ListPost): string {
  const owner = post.authors?.find((a) => a.id === post.user_id)
  return owner?.full_name || owner?.username || post.username
}

export type PostAccess = {
  canEdit: boolean
  // What editing means here ("your draft"), or why it's view-only; shown to contributors.
  note?: string
}

// The "Your access" column. Contributors may edit the working copy of the posts they
// own, at any status (canEditPost), and an editor publishes it, and of someone else's
// published post they were granted edit access to (#321, `collaborator`, from
// markCollaborations). Everything else opens view-only, including posts that only credit
// them as an author.
export function postAccess(user: PermissionUser | null | undefined, post: ListPost): PostAccess {
  if (canEditPost(user, post)) {
    if (isContentModerator(user?.role)) return { canEdit: true }
    if (post.collaborator && post.user_id !== user?.id) {
      return { canEdit: true, note: `edit access granted · ${ownerName(post)} owns it` }
    }
    const live = post.post_status?.toLowerCase() === "published"
    return { canEdit: true, note: live ? "an editor publishes your changes" : "your draft" }
  }
  // Their own scheduled post (#147): read-only until an editor cancels the schedule.
  if (user && post.user_id === user.id && post.post_status?.toLowerCase() === "scheduled") {
    return { canEdit: false, note: "scheduled by an editor" }
  }
  const credited = !!user && !!post.authors?.some((a) => a.id === user.id)
  return { canEdit: false, note: credited ? `You’re credited · ${ownerName(post)} owns it` : undefined }
}

// Marks the rows the signed-in member holds an edit access grant on (#321;
// GET /posts/collaborations), so postAccess offers Edit for them.
export function markCollaborations<T extends { id: number }>(posts: T[], grantedIds: readonly number[]): (T & { collaborator?: boolean })[] {
  if (grantedIds.length === 0) return posts
  const granted = new Set(grantedIds)
  return posts.map((post) => (granted.has(post.id) ? { ...post, collaborator: true } : post))
}

// The row actions (#340, Duplicate #354, the trash #327); the design's View on site waits
// for its issue. "delete" is the permanent delete, from the trash only.
export type RowAction = "duplicate" | "publish" | "unpublish" | "archive" | "trash" | "restore" | "delete"

// The toast after Duplicate, which then opens the copy in the editor.
export const DUPLICATED_MESSAGE = "Duplicated. You’re editing the copy."

// Duplicating needs read access and the right to create posts: any content role, on
// any post (the copy is a draft the caller owns). Publishing, unpublishing and
// archiving (a status change) are moderator-only in the API. Moving to the trash has the
// old delete's rule (canTrashPost): a contributor only their own post that isn't
// published. A trashed post only comes back (canRestorePost) or goes for good
// (canDeletePostPermanently, moderators).
export function rowActions(user: PermissionUser | null | undefined, post: ListPost): RowAction[] {
  const status = post.post_status?.toLowerCase()
  const actions: RowAction[] = []
  if (isTrashed(post)) {
    if (canRestorePost(user, post)) actions.push("restore")
    if (canDeletePostPermanently(user, post)) actions.push("delete")
    return actions
  }
  if (canCreateContent(user?.role)) actions.push("duplicate")
  if (isContentModerator(user?.role)) {
    actions.push(status === "published" ? "unpublish" : "publish")
    if (status !== "archived") actions.push("archive")
  }
  if (canTrashPost(user, post)) actions.push("trash")
  return actions
}

// Bulk actions (#327): what the bar offers on a tab. The API checks each post again and
// reports the ones it refused. "Change byline author" waits for #319's byline writes.
export type { BulkAction }

export function bulkActions(user: PermissionUser | null | undefined, tab: ListTab): BulkAction[] {
  const moderator = isContentModerator(user?.role)
  if (tab.status === "trash") return moderator ? ["restore", "delete"] : ["restore"]
  if (!canCreateContent(user?.role)) return []
  return moderator ? ["publish", "trash"] : ["trash"]
}

export const BULK_LABELS: Record<BulkAction, string> = {
  publish: "Publish",
  trash: "Move to trash",
  restore: "Restore",
  delete: "Delete permanently",
}

const BULK_VERB: Record<BulkAction, string> = {
  publish: "published",
  trash: "moved to the trash",
  restore: "restored",
  delete: "deleted",
}

// Why one post's bulk action failed, from the API's code (api/posts_trash.go).
export function bulkFailureReason(result: { code?: string; error?: string }): string {
  switch (result.code) {
    case "forbidden":
      return "You don’t have permission"
    case "not_found":
      return "It no longer exists"
    case "post_trashed":
      return "It’s in the trash"
    case "not_in_trash":
      return "It isn’t in the trash"
    case "collab_unavailable":
      return "The latest edits couldn’t be saved; try again"
    default:
      return result.error || "Something went wrong"
  }
}

const countOf = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`

export type BulkResult = { id: number; ok: boolean; code?: string; error?: string }

export type BulkReport = {
  // "3 posts moved to the trash" (null when none succeeded).
  done: string | null
  // "2 posts weren't published" (null when none failed).
  failed: string | null
  // One line per failure: the post's title and why.
  failures: { id: number; title: string; reason: string }[]
}

// The report after a bulk action: what worked, then each post that didn't and why
// (partial failures). `titles` names the selected posts; an id it doesn't know is
// "Post 12".
export function bulkReport(action: BulkAction, results: BulkResult[], titles: Map<number, string>, noun = "post"): BulkReport {
  const ok = results.filter((r) => r.ok).length
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1)
  const failures = results
    .filter((r) => !r.ok)
    .map((r) => ({ id: r.id, title: titles.get(r.id) || `${Noun} ${r.id}`, reason: bulkFailureReason(r) }))
  const n = failures.length
  return {
    done: ok === 0 ? null : `${countOf(ok, noun)} ${BULK_VERB[action]}`,
    failed: n === 0 ? null : `${countOf(n, noun)} ${n === 1 ? "wasn’t" : "weren’t"} ${BULK_VERB[action]}`,
    failures,
  }
}

// After a bulk action the posts that failed stay selected, so they can be dealt with next.
export function selectionAfterBulk(results: BulkResult[]): number[] {
  return results.filter((r) => !r.ok).map((r) => r.id)
}

// The list filters (#327): Author (byline), Category and Tag, from the URL (?author=,
// ?category=, ?tag=) to the API's author_id and terms. Ids only; anything else is ignored.
export type ListFilters = { author: string; category: string; tag: string }

const ID = /^[1-9][0-9]{0,18}$/

export function readListFilters(params: URLSearchParams): ListFilters {
  const id = (key: string) => {
    const v = params.get(key)?.trim() ?? ""
    return ID.test(v) ? v : ""
  }
  return { author: id("author"), category: id("category"), tag: id("tag") }
}

export function filterQuery(filters: ListFilters): { author_id: string; terms: string } {
  return { author_id: filters.author, terms: [filters.category, filters.tag].filter(Boolean).join(",") }
}

export function hasFilters(filters: ListFilters): boolean {
  return !!(filters.author || filters.category || filters.tag)
}

// "Trashed 3 days ago" for the Trash tab's rows.
export function trashedPhrase(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "In the trash"
  const when = formatLastEdited(iso, now)
  return `Trashed ${/^(Just|Yesterday)/.test(when) ? when.toLowerCase() : when}`
}

// Posts never updated keep the 0001-01-01 changed_at sentinel; like the API's
// sort=changed_at, they were last edited when they were created.
export function lastEdited(post: Pick<Post, "created_at" | "changed_at">): string {
  const changed = Date.parse(post.changed_at)
  const created = Date.parse(post.created_at)
  if (Number.isNaN(changed) || changed < created) return post.created_at
  return post.changed_at
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

// "Just now", "5 minutes ago", "2 hours ago", "Yesterday", "Oct 24", "Oct 24, 2025".
export function formatLastEdited(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  const diff = now.getTime() - date.getTime()
  if (diff < MINUTE) return "Just now"
  if (diff < HOUR) {
    const m = Math.floor(diff / MINUTE)
    return `${m} minute${m === 1 ? "" : "s"} ago`
  }
  const days = Math.round((startOfDay(now) - startOfDay(date)) / (24 * HOUR))
  if (days === 0) {
    const h = Math.floor(diff / HOUR)
    return `${h} hour${h === 1 ? "" : "s"} ago`
  }
  if (days === 1) return "Yesterday"
  const sameYear = date.getFullYear() === now.getFullYear()
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) })
}

// In a sentence: "Edited just now", "Edited yesterday", "Edited Oct 24".
export function editedPhrase(iso: string, now: Date = new Date()): string {
  const when = formatLastEdited(iso, now)
  return `Edited ${/^(Just|Yesterday)/.test(when) ? when.toLowerCase() : when}`
}
