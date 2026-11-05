import { apiCall } from "../api"

// Review requests (#323): api/review_requests.go. One open request per post; it
// resolves when the post is published (any path), dismissed, or a reviewer asks for
// changes with a note.

export interface ReviewPerson {
  id: number
  username: string
  full_name: string
  avatar: string | null
}

export type ReviewStatus = "open" | "published" | "dismissed" | "changes_requested"

export interface ReviewRequest {
  id: number
  post_id: number
  status: ReviewStatus
  // The requester's note, and the reviewer's with changes_requested; plain text.
  message: string
  resolution_note: string
  created_at: string
  resolved_at: string | null
  requested_by: ReviewPerson | null
  // null = any editor or admin.
  reviewer: ReviewPerson | null
  resolved_by: ReviewPerson | null
}

// The posts list's indicator: a row's open request.
export interface ReviewRequestSummary {
  id: number
  created_at: string
  requested_by: ReviewPerson | null
  reviewer: ReviewPerson | null
}

// The post's open request, or the latest one when changes were requested and nothing
// was published since (the editor's notice); null otherwise.
export async function getPostReviewRequest(postId: number): Promise<ReviewRequest | null> {
  const response = await apiCall(`/posts/${postId}/review-request`)
  return response.review_request ?? null
}

// A 409 with code review_already_requested means one is open already.
export async function requestReview(postId: number, body: { reviewer_id?: number; message?: string } = {}): Promise<ReviewRequest> {
  const response = await apiCall(`/posts/${postId}/review-request`, { method: "POST", body })
  return response.review_request
}

// Who can be named: editors and admins.
export async function getReviewers(): Promise<ReviewPerson[]> {
  const response = await apiCall("/posts/reviewers")
  return response.reviewers ?? []
}

// A reviewer dismisses it, or the requester withdraws it.
export async function dismissReviewRequest(id: number): Promise<ReviewRequest> {
  const response = await apiCall(`/review-requests/${id}/dismiss`, { method: "POST" })
  return response.review_request
}

export async function requestReviewChanges(id: number, note: string): Promise<ReviewRequest> {
  const response = await apiCall(`/review-requests/${id}/request-changes`, { method: "POST", body: { note } })
  return response.review_request
}
