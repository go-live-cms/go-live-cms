import { apiCall } from "../api"
import type { DiscussionStateName } from "@/lib/discussion"

// Discussion, the reader comments' moderation (#526; api/discussion_admin.go, design
// docs/design/reader-comments.md 4.4, 9.3). Editors and admins only: contributors get 403
// on every route (decision 3), so nothing here is called for them.

export type ReaderCommentStatus = "pending" | "approved" | "spam" | "trash"
export type ReaderCommentAction = "approve" | "unapprove" | "spam" | "not_spam" | "trash" | "restore"
export type ReaderCommentBulkAction = ReaderCommentAction | "delete"

export interface ModerationCommenter {
  id: number
  // The address in full: moderators only (decision 6), never shown publicly.
  email: string
  // "New commenter": nothing of theirs approved yet.
  new: boolean
  blocked: boolean
}

export interface ModerationPost {
  id: number
  title: string
  post_type: string
  status: string
  // The public path ("/post/hello-world").
  url: string
}

export interface ModerationComment {
  id: number
  parent_id: number | null
  root_id: number | null
  status: ReaderCommentStatus
  trashed_from: ReaderCommentStatus | null
  held_reason: string | null
  held_detail: string | null
  name: string
  badge: "author" | "staff" | null
  avatar: string | null
  author_user_id: number | null
  commenter: ModerationCommenter | null
  body: string
  replying_to: string
  notify_replies: boolean
  edited: boolean
  removed: boolean
  created_at: string
  approved_at: string | null
  moderated_at: string | null
  moderated_by: string
  post: ModerationPost
}

export interface DiscussionCounts {
  pending: number
  approved: number
  spam: number
  trash: number
}

export interface DiscussionFilters {
  post_id?: number | null
  commenter_id?: number | null
  q?: string
}

export interface DiscussionPage {
  comments: ModerationComment[]
  counts: DiscussionCounts
  // null when the API couldn't read the settings: then the queue doesn't claim comments are off.
  comments_enabled: boolean | null
  pagination: { page: number; per_page: number; total: number; total_pages: number }
}

export interface CommenterSummary {
  id: number
  email: string
  name: string
  names_used: string[]
  verified_at: string | null
  blocked_at: string | null
  blocked_by: string
  last_spam_at: string | null
  created_at: string
  approved: number
  pending: number
  spam: number
  trash: number
  notify_count: number
  network_neighbours: number
}

export interface DiscussionThread {
  comment: ModerationComment
  thread: ModerationComment[]
  commenter: CommenterSummary | null
  discussion: { state: DiscussionStateName; closes_at: string | null } | null
}

export interface BulkCommentResult {
  id: number
  ok: boolean
  comment_status?: ReaderCommentStatus
  status?: number
  code?: string
  error?: string
}

export interface BulkCommentsAnswer {
  action: ReaderCommentBulkAction
  results: BulkCommentResult[]
  succeeded: number
  failed: number
}

// Fired after any moderation, so the sidebar's pending count follows.
export const DISCUSSION_CHANGED = "gl:discussion-changed"

export function announceDiscussionChanged() {
  window.dispatchEvent(new Event(DISCUSSION_CHANGED))
}

function filterParams(filters: DiscussionFilters, params = new URLSearchParams()): URLSearchParams {
  if (filters.post_id) params.set("post_id", String(filters.post_id))
  if (filters.commenter_id) params.set("commenter_id", String(filters.commenter_id))
  if (filters.q?.trim()) params.set("q", filters.q.trim())
  return params
}

export async function getDiscussionComments(
  status: ReaderCommentStatus,
  filters: DiscussionFilters,
  page = 1,
  limit = 25
): Promise<DiscussionPage> {
  const params = filterParams(filters, new URLSearchParams({ status, page: String(page), limit: String(limit) }))
  return apiCall(`/discussion/comments?${params}`)
}

export async function getDiscussionCounts(filters: DiscussionFilters = {}): Promise<DiscussionCounts> {
  const params = filterParams(filters).toString()
  const answer = await apiCall(`/discussion/counts${params ? `?${params}` : ""}`)
  return answer.counts
}

export async function getDiscussionThread(id: number): Promise<DiscussionThread> {
  return apiCall(`/discussion/comments/${id}/thread`)
}

export async function moderateComment(id: number, action: ReaderCommentAction): Promise<ModerationComment> {
  const answer = await apiCall(`/discussion/comments/${id}/status`, { method: "PUT", body: { action } })
  return answer.comment
}

export async function deleteCommentPermanently(id: number): Promise<void> {
  await apiCall(`/discussion/comments/${id}`, { method: "DELETE" })
}

export async function bulkModerateComments(action: ReaderCommentBulkAction, ids: number[]): Promise<BulkCommentsAnswer> {
  return apiCall(`/discussion/comments/bulk`, { method: "POST", body: { action, ids } })
}

export async function postMemberComment(
  postId: number,
  body: string,
  parentId?: number | null
): Promise<{ comment: ModerationComment; parent_approved: boolean }> {
  return apiCall(`/discussion/posts/${postId}/comments`, {
    method: "POST",
    body: parentId ? { body, parent_id: parentId } : { body },
  })
}

export async function editMemberComment(id: number, body: string): Promise<ModerationComment> {
  const answer = await apiCall(`/discussion/comments/${id}`, { method: "PUT", body: { body } })
  return answer.comment
}

export async function findCommenter(email: string): Promise<number> {
  const answer = await apiCall(`/discussion/commenters?${new URLSearchParams({ email: email.trim() })}`)
  return answer.id
}

export async function getCommenter(id: number): Promise<{ commenter: CommenterSummary; comments: ModerationComment[] }> {
  return apiCall(`/discussion/commenters/${id}`)
}

export async function setCommenterBlocked(id: number, blocked: boolean): Promise<CommenterSummary> {
  const answer = await apiCall(`/discussion/commenters/${id}/block`, { method: "PUT", body: { blocked } })
  return answer.commenter
}
