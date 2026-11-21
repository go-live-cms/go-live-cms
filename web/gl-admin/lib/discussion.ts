import { readerCommentLinks } from "@/lib/discussion"
import type {
  BulkCommentResult,
  CommenterSummary,
  ModerationComment,
  ReaderCommentAction,
  ReaderCommentBulkAction,
  ReaderCommentStatus,
} from "@gl-admin/lib/api/discussion"
import { formatLastEdited } from "@gl-admin/lib/contentList"

// Discussion's rules and wording (#526; design docs/design/reader-comments.md 4, 16.1, the
// #521 boards "Discussion · queue", "comment drawer", "commenter" and "375 · Discussion").
// What each tab and row offers, why a comment is held or in spam, the bulk report, the
// reply box's words, Home's item and the sidebar's count. The API enforces all of it
// (api/discussion_admin.go); these say it to the moderator first.

export type DiscussionTab = { id: ReaderCommentStatus; label: string }

export const DISCUSSION_TABS: DiscussionTab[] = [
  { id: "pending", label: "Pending" },
  { id: "approved", label: "Approved" },
  { id: "spam", label: "Spam" },
  { id: "trash", label: "Trash" },
]

export function findDiscussionTab(id: string | null | undefined): DiscussionTab {
  return DISCUSSION_TABS.find((t) => t.id === id) ?? DISCUSSION_TABS[0]
}

// A row's actions: the buttons, in order. Reply and Edit open the drawer.
export type RowAction = ReaderCommentBulkAction | "reply" | "edit"

export const ACTION_LABELS: Record<RowAction, string> = {
  approve: "Approve",
  unapprove: "Unapprove",
  spam: "Spam",
  not_spam: "Not spam",
  trash: "Trash",
  restore: "Restore",
  delete: "Delete permanently",
  reply: "Reply",
  edit: "Edit",
}

export function isOwnComment(comment: Pick<ModerationComment, "author_user_id">, meId: number | null | undefined): boolean {
  return meId != null && comment.author_user_id === meId
}

// 16.1: Pending: Approve, Spam, Trash, Reply; Approved: Unapprove first (Edit first on
// your own comment), then Spam, Trash, Reply; Spam: Not spam, Delete permanently; Trash:
// Restore, Delete permanently. A tombstone takes nothing.
export function rowActions(comment: ModerationComment, meId: number | null | undefined): RowAction[] {
  if (comment.removed) return []
  switch (comment.status) {
    case "pending":
      return ["approve", "spam", "trash", "reply"]
    case "approved":
      return [...(isOwnComment(comment, meId) ? (["edit"] as RowAction[]) : []), "unapprove", "spam", "trash", "reply"]
    case "spam":
      return ["not_spam", "delete"]
    case "trash":
      return ["restore", "delete"]
  }
}

// At 375 (16.1): the first two as 44px buttons, the rest behind More. Replying and
// editing need a larger screen.
export function phoneActions(comment: ModerationComment): { primary: RowAction[]; more: RowAction[] } {
  const all = rowActions(comment, null).filter((a) => a !== "reply" && a !== "edit")
  return { primary: all.slice(0, 2), more: all.slice(2) }
}

// The bulk bar's actions for a tab (4.4).
export function bulkActionsFor(tab: ReaderCommentStatus): ReaderCommentBulkAction[] {
  switch (tab) {
    case "pending":
      return ["approve", "spam", "trash"]
    case "approved":
      return ["unapprove", "spam", "trash"]
    case "spam":
      return ["not_spam", "delete"]
    case "trash":
      return ["restore", "delete"]
  }
}

export const STATUS_LABELS: Record<ReaderCommentStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  spam: "Spam",
  trash: "Trash",
}

export type ReasonTone = "warning" | "danger" | "neutral"

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// Why a pending comment is held (4.2, 16.2), or why a spam one is there (16.1). null when
// nothing says (an unapproved comment, a moderator's own hold).
export function reasonLabel(comment: Pick<ModerationComment, "status" | "held_reason" | "held_detail" | "moderated_by" | "body">): string | null {
  const detail = comment.held_detail?.trim() ?? ""
  if (comment.status === "spam") {
    switch (comment.held_reason) {
      case "spam_word":
        return detail ? `Spam word: ${detail}` : "Spam word"
      case "honeypot":
        return "Filled the hidden field"
      case "plugin":
        return detail ? `Plugin: ${detail}` : "A plugin's check"
      case "blocked":
        return "Blocked commenter"
      case "moderator":
        return comment.moderated_by ? `Marked by ${comment.moderated_by}` : "Marked by a moderator"
    }
    return "Spam"
  }
  if (comment.status !== "pending") return null
  switch (comment.held_reason) {
    case "first_comment":
      return "First comment"
    case "moderation_all":
      return "Every comment is held"
    case "links":
      return `${plural(readerCommentLinks(comment.body).length, "link")} · over the limit`
    case "held_word":
      return detail ? `Held word: ${detail}` : "Held word"
    case "member_name":
      return "Name matches a member"
    case "previous_spam":
      return "Marked spam before"
    case "plugin":
      return detail ? `Plugin: ${detail}` : "Held by a plugin"
  }
  return null
}

// The pill beside the name in a thread: status and reason ("Pending · First comment").
export function threadPill(comment: ModerationComment): { label: string; tone: "warning" | "danger" | "neutral" } | null {
  if (comment.removed || comment.status === "approved") return null
  const reason = reasonLabel(comment)
  const label = reason ? `${STATUS_LABELS[comment.status]} · ${reason}` : STATUS_LABELS[comment.status]
  return { label, tone: comment.status === "spam" ? "danger" : comment.status === "pending" ? "warning" : "neutral" }
}

export const BADGE_LABELS = { author: "Author", staff: "Staff" } as const

// How a comment is named to a screen reader: "Maya Lindqvist, pending".
export function commentLabel(comment: ModerationComment): string {
  if (comment.removed) return "Removed comment"
  return `${comment.name || "Someone"}, ${STATUS_LABELS[comment.status].toLowerCase()}`
}

export const EXCERPT_LENGTH = 300

// The queue shows the first 300 characters, expandable (4.4).
export function excerpt(body: string, expanded: boolean): { text: string; truncated: boolean } {
  const chars = Array.from(body)
  if (expanded || chars.length <= EXCERPT_LENGTH) return { text: body, truncated: false }
  return { text: `${chars.slice(0, EXCERPT_LENGTH).join("").trimEnd()}…`, truncated: true }
}

export const firstName = (name: string) => name.trim().split(/\s+/)[0] || name

// "Trashed by Ana Costa · Nov 12" and "Deleted Dec 12" (30 days after, 6.4).
export const TRASH_DAYS = 30
export function trashLines(comment: Pick<ModerationComment, "moderated_at" | "moderated_by" | "created_at">, now = new Date()): string[] {
  const at = comment.moderated_at ?? comment.created_at
  const when = formatLastEdited(at, now)
  const lines = [comment.moderated_by ? `Trashed by ${comment.moderated_by} · ${when}` : `Trashed ${when}`]
  const goes = new Date(Date.parse(at) + TRASH_DAYS * 24 * 3_600_000)
  if (!Number.isNaN(goes.getTime())) {
    lines.push(`Deleted ${goes.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`)
  }
  return lines
}

// What a single action says when it's done (the boards' toasts).
export function actionDoneMessage(action: ReaderCommentBulkAction): string {
  switch (action) {
    case "approve":
      return "Approved. It's on the post now."
    case "unapprove":
      return "Unapproved. It's back in Pending."
    case "spam":
      return "Marked as spam."
    case "not_spam":
      return "Not spam. It's back in Pending."
    case "trash":
      return "Moved to the trash."
    case "restore":
      return "Restored."
    case "delete":
      return "Deleted for good."
  }
}

const BULK_DONE: Record<ReaderCommentBulkAction, string> = {
  approve: "Approved",
  unapprove: "Unapproved",
  spam: "Marked as spam",
  not_spam: "Moved back to Pending",
  trash: "Moved to the trash",
  restore: "Restored",
  delete: "Deleted",
}

// Why one comment of a bulk action didn't apply.
export function failureReason(result: BulkCommentResult): string {
  if (result.status === 404) return "it was deleted by someone else meanwhile"
  if (result.code === "comment_status_changed") return "someone else moved it meanwhile"
  return result.error || "it couldn't be changed"
}

export type DiscussionBulkReport = { message: string; partial: boolean; failures: { id: number; name: string; reason: string }[] }

// "Approved 3 comments." or, partly, "Approved 2 of 3. One comment was deleted by someone
// else meanwhile." (16.1).
export function bulkReport(action: ReaderCommentBulkAction, results: BulkCommentResult[], names: Map<number, string>): DiscussionBulkReport {
  const done = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)
  const failures = failed.map((r) => ({ id: r.id, name: names.get(r.id) || "A comment", reason: failureReason(r) }))
  if (failed.length === 0) {
    return { message: `${BULK_DONE[action]} ${plural(done, "comment")}.`, partial: false, failures }
  }
  const head = done === 0 ? `Nothing changed.` : `${BULK_DONE[action]} ${done} of ${results.length}.`
  const tail =
    failed.length === 1
      ? ` One comment wasn't: ${failures[0].reason}.`
      : ` ${failed.length} comments weren't: someone else changed them meanwhile.`
  return { message: head + tail, partial: true, failures }
}

// After a bulk action the selection keeps what failed and still exists, to try again.
export function selectionAfterBulk(results: BulkCommentResult[]): number[] {
  return results.filter((r) => !r.ok && r.status !== 404).map((r) => r.id)
}

// Delete permanently asks first (16.1).
export function deleteConfirm(count: number): { title: string; body: string; button: string } {
  return {
    title: count === 1 ? "Delete this comment for good?" : `Delete ${count} comments for good?`,
    body:
      "They're removed now instead of after 30 days. A comment with approved replies becomes “This comment was removed”, so the replies stay. This can't be undone.",
    button: count === 1 ? "Delete comment" : `Delete ${count} comments`,
  }
}

// The reply box (4.4, 16.1): "Reply to Maya as Luan"; a pending comment is approved first.
export function canReplyTo(comment: ModerationComment): boolean {
  return !comment.removed && (comment.status === "pending" || comment.status === "approved")
}

export function replyLabel(comment: ModerationComment, me: string): string {
  return `Reply to ${firstName(comment.name || "this comment")} as ${me}`
}

export function replyButton(comment: ModerationComment): string {
  return comment.status === "pending" ? "Approve and reply" : "Reply"
}

export function replyHint(comment: ModerationComment): string {
  const who = firstName(comment.name || "This")
  const shows = "Your reply is approved at once, with the Author badge if you're on the post's byline, else Staff."
  return comment.status === "pending" ? `${who}'s comment is pending, so replying approves it first. ${shows}` : shows
}

export function replyPosted(parentApproved: boolean, parent: ModerationComment): string {
  return parentApproved ? `Reply posted. ${firstName(parent.name)}'s comment is approved.` : "Reply posted."
}

// A refused reply keeps its text; the box says why.
export function replyFailure(code: string | null | undefined): { title: string; body: string } {
  if (code === "parent_not_found") {
    return {
      title: "Your reply wasn't posted",
      body: "The comment it answers was deleted or moved while you were writing. Your text is still in the box: copy it, or reply to the post instead.",
    }
  }
  if (code === "comments_off") {
    return { title: "Your reply wasn't posted", body: "Comments are off for this site. Your text is still in the box." }
  }
  return { title: "Your reply wasn't posted", body: "Something went wrong. Your text is still in the box; try again." }
}

// "Comments open · closes Dec 3" in the drawer's header.
export function discussionLine(discussion: { state: "open" | "closed" | "off"; closes_at: string | null } | null): string | null {
  if (!discussion) return null
  if (discussion.state === "off") return "Comments off"
  if (discussion.state === "closed") return "Comments closed"
  if (!discussion.closes_at) return "Comments open"
  const day = new Date(discussion.closes_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })
  return `Comments open · closes ${day}`
}

// The commenter's summary lines (4.4, 16.1).
export function commenterLine(summary: Pick<CommenterSummary, "email" | "verified_at">): string {
  if (!summary.verified_at) return summary.email
  const day = new Date(summary.verified_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })
  return `${summary.email} · verified ${day}`
}

export function networkLine(n: number): string | null {
  if (n <= 0) return null
  return n === 1 ? "1 other commenter from this network" : `${n} other commenters from this network`
}

export function commenterCounts(summary: Pick<CommenterSummary, "approved" | "pending" | "spam">): string[] {
  return [`${summary.approved} approved`, `${summary.pending} pending`, `${summary.spam} spam`]
}

export function blockedLine(summary: Pick<CommenterSummary, "blocked_at" | "blocked_by">): string | null {
  if (!summary.blocked_at) return null
  const day = new Date(summary.blocked_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })
  return summary.blocked_by ? `Blocked by ${summary.blocked_by} on ${day}` : `Blocked on ${day}`
}

export function mailLine(n: number): string {
  if (n === 0) return "No reply mail."
  return `Replies by email on ${plural(n, "comment")}.`
}

// Erase (#529, design 13.1, the commenter board's confirmation): "Delete Ana's 14 comments and
// everything stored about this address?". The count is every comment erasure deletes, the
// unconfirmed ones included, so it matches what the API answers afterwards.
export function eraseConfirm(summary: Pick<CommenterSummary, "name" | "approved" | "pending" | "spam" | "trash" | "unconfirmed">): {
  title: string
  body: string
  button: string
} {
  const count = summary.approved + summary.pending + summary.spam + summary.trash + (summary.unconfirmed ?? 0)
  const name = summary.name.trim() || "this commenter"
  const owner = name.endsWith("s") ? `${name}’` : `${name}’s`
  return {
    title: count === 0 ? `Delete everything stored about ${name}?` : `Delete ${owner} ${plural(count, "comment")} and everything stored about this address?`,
    body: "Comments with replies are replaced by “This comment was removed”. Their mail stops, and the address is forgotten. Backups made before today keep it until they expire. This can't be undone.",
    button: "Erase",
  }
}

// After Erase: what the toast says ("Erased 14 comments. 2 became “This comment was removed”.").
export function erasedMessage(result: { comment_count: number; tombstoned: number }): string {
  const what = result.comment_count === 0 ? "Erased the commenter." : `Erased ${plural(result.comment_count, "comment")}.`
  if (result.tombstoned === 0) return what
  return `${what} ${result.tombstoned === 1 ? "One became" : `${result.tombstoned} became`} “This comment was removed”: replies answer ${result.tombstoned === 1 ? "it" : "them"}.`
}

// Export's file name: "commenter-12.json", the API's Content-Disposition.
export function exportFileName(id: number): string {
  return `commenter-${id}.json`
}

// The post's state in a row: "Post not published" (4.4).
export function postNotPublished(comment: Pick<ModerationComment, "post">): boolean {
  return comment.post.status !== "published"
}

// Home's Needs attention (4.4, 16.1): "4 comments await moderation", "On 3 posts · the
// oldest is 2 hours old". Nothing when nothing waits.
export function pendingAttention(
  summary: { count: number; post_count: number; oldest_at: string | null } | null | undefined,
  now = new Date()
): { title: string; detail: string } | null {
  if (!summary || summary.count <= 0) return null
  const title = summary.count === 1 ? "1 comment awaits moderation" : `${summary.count} comments await moderation`
  const parts = [summary.post_count === 1 ? "On 1 post" : `On ${summary.post_count} posts`]
  if (summary.oldest_at) {
    const age = oldestAge(summary.oldest_at, now)
    if (age) parts.push(`the oldest is ${age}`)
  }
  return { title, detail: parts.join(" · ") }
}

function oldestAge(iso: string, now: Date): string | null {
  const ms = now.getTime() - Date.parse(iso)
  if (Number.isNaN(ms)) return null
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return "new"
  if (minutes < 60) return `${plural(minutes, "minute")} old`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${plural(hours, "hour")} old`
  return `${plural(Math.floor(hours / 24), "day")} old`
}

// The sidebar's entry with its count (16.1): the pill is decoration, the link says it.
export function discussionNavLabel(pending: number | null | undefined): string {
  if (!pending) return "Discussion"
  return `Discussion, ${plural(pending, "comment")} waiting`
}

// What the queue's empty state says, per tab and filters (16.1: "Nothing waits for review").
export function emptyQueue(tab: ReaderCommentStatus, filtered: boolean): { title: string; description: string } {
  if (filtered) return { title: "No comments match", description: "Try other words, or clear the filters." }
  switch (tab) {
    case "pending":
      return { title: "Nothing waits for review", description: "New comments that need a look show up here." }
    case "approved":
      return { title: "No approved comments yet", description: "Comments you approve show on their post." }
    case "spam":
      return { title: "No spam", description: "Comments the filters or a moderator mark as spam wait here for 30 days." }
    case "trash":
      return { title: "The trash is empty", description: "Comments in the trash are deleted for good after 30 days." }
  }
}

// The action a single row button calls the API with.
export function isApiAction(action: RowAction): action is ReaderCommentAction {
  return action !== "reply" && action !== "edit" && action !== "delete"
}

// The editor's Discussion section (12.3, 16.1): "12 comments · 2 waiting", linking to the
// queue filtered by the post. Nothing when the post has neither.
export function postCommentsLine(counts: { approved: number; pending: number } | null | undefined): string | null {
  if (!counts || counts.approved + counts.pending === 0) return null
  return `${plural(counts.approved, "comment")} · ${counts.pending} waiting`
}
