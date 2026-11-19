import { apiCall } from "../api"
import type { DiscussionStateName, PostDiscussion } from "@/lib/discussion"

// The post's Discussion choice (#522, #527; api/posts_discussion.go): editors and admins
// only (decision 3). It applies at once, outside the publish snapshot: no Update, and the
// post never shows "Changes not published" for it.

export interface PostDiscussionAnswer {
  post_id: number
  discussion: PostDiscussion
  // What the choice means now, the clock applied (the API's own reading of the rule).
  state: DiscussionStateName
  closes_at: string | null
  // The rule's input (12.4): when the post was first published, null for never.
  first_published_at: string | null
}

export async function getPostDiscussion(postId: number): Promise<PostDiscussionAnswer> {
  return apiCall(`/posts/${postId}/discussion`)
}

export async function setPostDiscussion(postId: number, discussion: PostDiscussion): Promise<PostDiscussionAnswer> {
  return apiCall(`/posts/${postId}/discussion`, { method: "PUT", body: { discussion } })
}
