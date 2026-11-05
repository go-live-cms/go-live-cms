import { apiCall } from "../api"
import type { PostAuthor } from "./types"

// Edit access requests and grants (#321; api/posts_access.go). A contributor watching
// someone else's published post asks for edit access; the owner, an editor or an admin
// grants or declines; a grant can be revoked. Who may do what is the API's
// (api/auth_posts.go: canRequestPostAccess, canReviewPostAccess).

export type AccessRequestStatus = "pending" | "granted" | "declined"

export interface AccessRequest {
  id: number
  post_id: number
  status: AccessRequestStatus
  message: string
  created_at: string
  reviewed_at: string | null
  // Who asked (in a reviewer's list).
  requester?: PostAuthor
  // When a declined request's member may ask again.
  request_again_at?: string
}

export interface PostCollaborator extends PostAuthor {
  granted_at: string
}

export interface PostAccess {
  // A read-write collab connection: ownership, a moderator's role, or a grant.
  can_edit: boolean
  // A grant is what allows it.
  collaborator: boolean
  // May ask for edit access now.
  can_request: boolean
  // The caller's latest request for this post.
  request: AccessRequest | null
  // Answers requests and revokes grants; then `pending` and `collaborators` are lists.
  can_review: boolean
  pending: AccessRequest[] | null
  collaborators: PostCollaborator[] | null
}

// The API's codes (409/404), for messages (lib/postAccess.ts).
export const ACCESS_CODES = {
  alreadyHasAccess: "already_has_access",
  requestOpen: "request_open",
  recentlyDeclined: "recently_declined",
  alreadyAnswered: "already_answered",
  notCollaborator: "not_a_collaborator",
} as const

export async function getPostAccess(postId: number): Promise<PostAccess> {
  const response = await apiCall(`/posts/${postId}/access`)
  return {
    can_edit: !!response.can_edit,
    collaborator: !!response.collaborator,
    can_request: !!response.can_request,
    request: response.request ?? null,
    can_review: !!response.can_review,
    pending: response.pending ?? null,
    collaborators: response.collaborators ?? null,
  }
}

// Throws ApiError (code request_open, recently_declined, already_has_access; 429).
export async function requestPostAccess(postId: number, message: string): Promise<AccessRequest> {
  const trimmed = message.trim()
  const response = await apiCall(`/posts/${postId}/access-requests`, { method: "POST", body: trimmed ? { message: trimmed } : {} })
  return response.request
}

export async function grantAccessRequest(postId: number, requestId: number): Promise<AccessRequest> {
  const response = await apiCall(`/posts/${postId}/access-requests/${requestId}/grant`, { method: "POST" })
  return response.request
}

export async function declineAccessRequest(postId: number, requestId: number): Promise<AccessRequest> {
  const response = await apiCall(`/posts/${postId}/access-requests/${requestId}/decline`, { method: "POST" })
  return response.request
}

export async function revokePostAccess(postId: number, userId: number): Promise<void> {
  await apiCall(`/posts/${postId}/collaborators/${userId}`, { method: "DELETE" })
}
