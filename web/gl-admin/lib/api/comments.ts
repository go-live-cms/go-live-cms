import { apiCall } from "../api"

// Block comments (#192): api/post_comments.go. A thread is anchored to a block by its
// data-block-id; every route answers the post's whole comment state, so the editor
// replaces what it shows with the answer.

export interface CommentPerson {
  id: number
  username: string
  full_name: string
  avatar: string | null
}

export interface BlockComment {
  id: number
  thread_id: number
  // null: a member removed since.
  author: CommentPerson | null
  // Plain text; "" when deleted.
  body: string
  created_at: string
  edited_at: string | null
  deleted: boolean
  can_edit: boolean
  can_delete: boolean
}

export interface CommentThread {
  id: number
  post_id: number
  block_id: string
  created_by: CommentPerson | null
  created_at: string
  resolved_at: string | null
  resolved_by: CommentPerson | null
  can_resolve: boolean
  comments: BlockComment[]
}

export interface PostComments {
  post_id: number
  can_comment: boolean
  threads: CommentThread[]
  // What a write created or changed.
  thread_id?: number
  comment_id?: number
}

const base = (postId: number) => `/posts/${postId}`

export async function getPostComments(postId: number): Promise<PostComments> {
  return apiCall(`${base(postId)}/comments`)
}

export async function startCommentThread(postId: number, blockId: string, body: string): Promise<PostComments> {
  return apiCall(`${base(postId)}/comments`, { method: "POST", body: { block_id: blockId, body } })
}

export async function replyToCommentThread(postId: number, threadId: number, body: string): Promise<PostComments> {
  return apiCall(`${base(postId)}/comment-threads/${threadId}/replies`, { method: "POST", body: { body } })
}

export async function setCommentThreadResolved(postId: number, threadId: number, resolved: boolean): Promise<PostComments> {
  return apiCall(`${base(postId)}/comment-threads/${threadId}/${resolved ? "resolve" : "unresolve"}`, { method: "POST" })
}

export async function editComment(postId: number, commentId: number, body: string): Promise<PostComments> {
  return apiCall(`${base(postId)}/comments/${commentId}`, { method: "PUT", body: { body } })
}

export async function deleteComment(postId: number, commentId: number): Promise<PostComments> {
  return apiCall(`${base(postId)}/comments/${commentId}`, { method: "DELETE" })
}
