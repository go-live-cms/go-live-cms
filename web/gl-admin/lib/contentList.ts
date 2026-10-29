import { canEditPost, canEditPostDetails, isContentModerator, type PermissionUser } from "@gl-admin/lib/roles"
import type { Post, PostSortField, SortOrder } from "@gl-admin/lib/api/types"

// The posts list's rules (#340), as data so they're testable: which status tabs a role
// gets and their counts, what the signed-in user may do to each row, the sort menu
// and how "last edited" reads. A UI hint only (lib/roles.ts): the API enforces it.

// "All" leaves archived posts out: archiving hides a post from the site and from All.
export const ACTIVE_STATUSES = "draft,published"

export type ListTab = {
  id: string
  label: string
  // The list's status filter: one status, a comma list, or "" for every status.
  status: string
  // Only the signed-in user's own posts (user_id).
  mine?: boolean
}

// Hidden until their issues land: Scheduled (#147) after Drafts, Trash (#327) last.
export const MODERATOR_TABS: ListTab[] = [
  { id: "all", label: "All", status: ACTIVE_STATUSES },
  { id: "published", label: "Published", status: "published" },
  { id: "draft", label: "Drafts", status: "draft" },
  { id: "archived", label: "Archived", status: "archived" },
]

// Contributors: their own posts at any status, and what's live.
const CONTRIBUTOR_TABS: ListTab[] = [
  { id: "all", label: "All", status: ACTIVE_STATUSES },
  { id: "mine", label: "My posts", status: "", mine: true },
  { id: "published", label: "Published", status: "published" },
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
// signed-in user's posts. null while either is still loading (the tab shows a skeleton).
export function tabCount(tab: ListTab, counts: StatusCounts | null, mine: StatusCounts | null = null): number | null {
  const source = tab.mine ? mine : counts
  if (!source) return null
  const statuses = tab.status ? tab.status.split(",") : Object.keys(source)
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

type ListPost = Pick<Post, "user_id" | "post_status" | "username" | "authors">

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
// own, at any status (canEditPost), and an editor publishes it. Everything else opens
// view-only, including posts that only credit them as an author.
export function postAccess(user: PermissionUser | null | undefined, post: ListPost): PostAccess {
  if (canEditPost(user, post)) {
    if (isContentModerator(user?.role)) return { canEdit: true }
    const live = post.post_status?.toLowerCase() === "published"
    return { canEdit: true, note: live ? "an editor publishes your changes" : "your draft" }
  }
  const credited = !!user && !!post.authors?.some((a) => a.id === user.id)
  return { canEdit: false, note: credited ? `You’re credited · ${ownerName(post)} owns it` : undefined }
}

// The row actions that exist today (#340); the design's Duplicate, View on site and
// Move to trash (#327) wait for theirs.
export type RowAction = "publish" | "unpublish" | "archive" | "delete"

// Publishing, unpublishing and archiving (a status change) are moderator-only in the
// API. Deleting needs canEditPostDetails: a contributor may delete their own post only
// while it isn't published.
export function rowActions(user: PermissionUser | null | undefined, post: ListPost): RowAction[] {
  const status = post.post_status?.toLowerCase()
  const actions: RowAction[] = []
  if (isContentModerator(user?.role)) {
    actions.push(status === "published" ? "unpublish" : "publish")
    if (status !== "archived") actions.push("archive")
  }
  if (canEditPostDetails(user, post)) actions.push("delete")
  return actions
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
