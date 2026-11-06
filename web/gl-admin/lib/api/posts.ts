import type {
  Post,
  PostAuthor,
  PostSEOSettings,
  PostSortOption,
  PostStatusCounts,
  ScheduledUpdate,
  SortOrder,
  PaginationParams,
  ApiResponse,
  TaxonomyTerm,
} from "./types"
import { apiCall, authenticatedFetch } from "../api"
import { apiErrorFromResponse } from "./errors"
import { buildUrl } from "./utils"
import type { BlockDocV1 } from "../blocks-spec"

export interface CreatePostRequest {
  title: string
  content: string
  // The excerpt: optional (#357), up to 500 characters.
  description: string
  url: string
  // Omitted → the API derives it from the title. Either way a clash gets -2, -3, ...
  slug?: string
  post_type?: string
  post_status?: string
  post_parent?: number | null
  menu_order?: number
  author_ids: number[]
  media_ids?: number[]
  taxonomy_ids?: number[]
  // The initial body (#206): the collab server seeds the doc from it on first open.
  block_doc?: BlockDocV1
}

export interface PostQueryParams extends PaginationParams {
  sort?: PostSortOption
  order?: SortOrder
  type?: string // post type name
  status?: string // one status, or a comma list ("draft,published")
  user_id?: string | number
  // Only published posts with changes not published (#326).
  unpublished_changes?: boolean
  // The list filters (#327): credited in the byline, and linked to every term (comma list).
  author_id?: string | number
  terms?: string
  // Review requested (#323): "pending" = an open review request.
  review?: string
  with_meta?: boolean
  meta_level?: string // 'basic' | 'full' | 'all'
}

export async function getPosts(params: PostQueryParams = {}): Promise<ApiResponse<Post>> {
  const url = buildUrl("/posts", params)
  const response = await apiCall(url)
  return {
    data: response.posts || [],
    meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
  }
}

// The posts list's search box (#145): the full-text index plus part of a title or slug
// (#327), with the list's type, status, owner, author and term filters, best match first. Rows are shaped like getPosts' with_meta rows.
export async function searchPosts(
  params: PaginationParams & {
    q: string
    type?: string
    status?: string
    user_id?: string | number
    unpublished_changes?: boolean
    author_id?: string | number
    terms?: string
    review?: string
  }
): Promise<ApiResponse<Post>> {
  const response = await apiCall(buildUrl("/posts/search", params))
  return {
    data: response.posts || [],
    meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
  }
}

// How many posts have each status, with the list's type and owner filters (#340), and how many
// have changes not published (#326).
export async function getPostCounts(
  params: { type?: string; user_id?: string | number } = {}
): Promise<PostStatusCounts> {
  const response = await apiCall(buildUrl("/posts/counts", params))
  return { counts: response.counts || {}, total: response.total || 0, unpublished_changes: response.unpublished_changes || 0 }
}

export async function getPostById(id: string | number): Promise<{ post: Post }> {
  return apiCall(`/posts/${id}`)
}

export async function getPostsByUser(
  userId: string | number,
  // GET /posts/user/:id always returns newest first; it takes no sort or order.
  params: PaginationParams = {}
): Promise<ApiResponse<Post>> {
  const url = buildUrl(`/posts/user/${userId}`, params)
  const response = await apiCall(url)
  return {
    data: response.posts || [],
    meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
  }
}

export async function getPostsByType(
  type: string,
  params: PaginationParams & { sort?: PostSortOption; order?: SortOrder } = {}
): Promise<ApiResponse<Post>> {
  const url = buildUrl(`/posts/type/${type}`, params)
  const response = await apiCall(url)
  return {
    data: response.posts || [],
    meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
  }
}

export async function getPostTaxonomies(postId: string | number): Promise<{ taxonomy_terms: TaxonomyTerm[] }> {
  return apiCall(`/posts/${postId}/taxonomies`)
}

export async function createPost(data: CreatePostRequest): Promise<any> {
  const response = await authenticatedFetch("/api/v1/posts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  })

  if (!response.ok) {
    throw await apiErrorFromResponse(response, { fallback: "Create post failed" })
  }

  return response.json()
}

// PUT /posts/:id/seo (#357): replaces the post's SEO settings. Editors and admins;
// on a published post they reach the site on Update.
export async function updatePostSEO(id: string | number, seo: PostSEOSettings): Promise<{ post: Post }> {
  const response = await authenticatedFetch(`/api/v1/posts/${id}/seo`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(seo),
  })
  if (!response.ok) {
    throw await apiErrorFromResponse(response, { fallback: "Saving the SEO settings failed" })
  }
  return response.json()
}

// PUT /posts/:id/template (#336): a page's template, "" for the theme's default. Like its
// other settings (canEditPostDetails); on a published page it reaches the site on Update.
export async function setPageTemplate(id: string | number, template: string): Promise<{ post: Post }> {
  const response = await authenticatedFetch(`/api/v1/posts/${id}/template`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ page_template: template }),
  })
  if (!response.ok) {
    throw await apiErrorFromResponse(response, { fallback: "Saving the template failed" })
  }
  return response.json()
}

// The byline (#319): who the post credits, in order. Separate from the owner
// (user_id), which alone decides access; on a published post a change reaches the
// site on Update.
export async function getPostAuthors(id: string | number): Promise<PostAuthor[]> {
  const response = await authenticatedFetch(`/api/v1/posts/${id}/authors`)
  if (!response.ok) {
    throw await apiErrorFromResponse(response, { fallback: "Loading the authors failed" })
  }
  const body = (await response.json()) as { authors?: PostAuthor[] }
  return body.authors ?? []
}

// Someone else saved the byline since `base` was loaded (409 byline_changed):
// nothing was written; `current` is their byline.
export class BylineChangedError extends Error {
  constructor(readonly current: PostAuthor[]) {
    super("Someone else changed the authors. Here are theirs: make your change again.")
    this.name = "BylineChangedError"
  }
}

// PUT /posts/:id/authors: replaces the byline (1–20 users, in credit order).
// `baseIds` is the byline the change was made to; if it's no longer the current
// one this throws BylineChangedError instead of overwriting someone's change.
export async function setPostAuthors(id: string | number, authorIds: number[], baseIds?: number[]): Promise<PostAuthor[]> {
  const response = await authenticatedFetch(`/api/v1/posts/${id}/authors`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(baseIds ? { author_ids: authorIds, base_author_ids: baseIds } : { author_ids: authorIds }),
  })
  if (response.status === 409) {
    const body = (await response.clone().json().catch(() => null)) as { code?: string; authors?: PostAuthor[] } | null
    if (body?.code === "byline_changed") throw new BylineChangedError(body.authors ?? [])
  }
  if (!response.ok) {
    throw await apiErrorFromResponse(response, { fallback: "Saving the authors failed" })
  }
  const body = (await response.json()) as { authors?: PostAuthor[] }
  return body.authors ?? []
}

// The owner (#353): who the post belongs to, which decides access. Public fields only.
export async function getPostOwner(id: string | number): Promise<PostAuthor> {
  const response = await authenticatedFetch(`/api/v1/posts/${id}/owner`)
  if (!response.ok) {
    throw await apiErrorFromResponse(response, { fallback: "Loading the owner failed" })
  }
  const body = (await response.json()) as { owner: PostAuthor }
  return body.owner
}

export interface TransferPostResult {
  post: Post
  owner: PostAuthor
  previous_owner_id: number
  // The working byline after the transfer, and whether it changed.
  authors: PostAuthor[]
  byline_changed: boolean
}

// POST /posts/:id/transfer (admins): gives the post to another active member. The
// byline stays as it is unless `replaceInByline` (the old owner's place goes to the new
// owner; on a published post that waits for Update). Errors carry the API's code
// (invalid_owner, already_owner, post_trashed).
export async function transferPost(id: string | number, userId: number, replaceInByline: boolean): Promise<TransferPostResult> {
  const response = await authenticatedFetch(`/api/v1/posts/${id}/transfer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, replace_in_byline: replaceInByline }),
  })
  if (!response.ok) {
    throw await apiErrorFromResponse(response, { fallback: "Transferring the post failed" })
  }
  return response.json()
}

// Who can be credited: members with a content role whose name or username
// contains `q` (up to 20). Any content role may ask.
export async function searchAuthorCandidates(q: string): Promise<PostAuthor[]> {
  const query = q.trim() ? `?q=${encodeURIComponent(q.trim().slice(0, 100))}` : ""
  const response = await authenticatedFetch(`/api/v1/posts/author-candidates${query}`)
  if (!response.ok) {
    throw await apiErrorFromResponse(response, { fallback: "Searching for authors failed" })
  }
  const body = (await response.json()) as { authors?: PostAuthor[] }
  return body.authors ?? []
}

export async function updatePost(id: string | number, data: Partial<Post>): Promise<any> {
  const response = await authenticatedFetch(`/api/v1/posts/${id}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  })

  if (!response.ok) {
    throw await apiErrorFromResponse(response, { fallback: "Update post failed" })
  }

  return response.json()
}

// Scheduled publishing (#147, editors and admins): schedule a draft, or move a
// scheduled post to a new time. `local` is a wall-clock time in the site's time zone
// ("2026-11-03T09:00"); the API converts it and answers with the post (publish_at in UTC).
export async function schedulePost(id: string | number, local: string): Promise<{ post: Post }> {
  const response = await authenticatedFetch(`/api/v1/posts/${id}/schedule`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ local }),
  })

  if (!response.ok) {
    throw await apiErrorFromResponse(response, { fallback: "Scheduling the post failed" })
  }

  return response.json()
}

// "Cancel schedule": the post goes back to draft.
export async function cancelPostSchedule(id: string | number): Promise<{ post: Post }> {
  const response = await authenticatedFetch(`/api/v1/posts/${id}/schedule`, {
    method: "DELETE",
  })

  if (!response.ok) {
    throw await apiErrorFromResponse(response, { fallback: "Cancelling the schedule failed" })
  }

  return response.json()
}

// A published post's scheduled update (#335, editors and admins): the API flushes the
// collab document and freezes the working copy as it is now, to go live at `local` (a
// wall-clock time in the site's zone). Scheduling again takes a new snapshot.
export async function scheduleUpdate(id: string | number, local: string): Promise<{ scheduled_update: ScheduledUpdate }> {
  const response = await authenticatedFetch(`/api/v1/posts/${id}/scheduled-update`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ local }),
  })

  if (!response.ok) {
    throw await apiErrorFromResponse(response, { fallback: "Scheduling the update failed" })
  }

  return response.json()
}

// "Cancel update": the live post and the working copy stay as they are.
export async function cancelScheduledUpdate(id: string | number): Promise<void> {
  const response = await authenticatedFetch(`/api/v1/posts/${id}/scheduled-update`, {
    method: "DELETE",
  })

  if (!response.ok) {
    throw await apiErrorFromResponse(response, { fallback: "Cancelling the update failed" })
  }
}

// A draft copy owned by the caller (#354): same type, parent, terms, featured image
// and description, the working copy's content with new block ids. Not its versions.
export async function duplicatePost(id: string | number): Promise<{ post: Post }> {
  const response = await authenticatedFetch(`/api/v1/posts/${id}/duplicate`, {
    method: "POST",
  })

  if (!response.ok) {
    throw await apiErrorFromResponse(response, { fallback: "Duplicate post failed" })
  }

  return response.json()
}

// DELETE /posts/:id moves the post to the trash (#327); restorePost takes it out with the
// status it had, deletePostPermanently (editors and admins, trashed posts only) removes it.
export async function trashPost(id: string | number): Promise<{ post: Post }> {
  const response = await authenticatedFetch(`/api/v1/posts/${id}`, {
    method: "DELETE",
  })

  if (!response.ok) {
    throw await apiErrorFromResponse(response, { fallback: "Moving the post to the trash failed" })
  }

  return response.json()
}

export async function restorePost(id: string | number): Promise<{ post: Post }> {
  const response = await authenticatedFetch(`/api/v1/posts/${id}/restore`, { method: "POST" })
  if (!response.ok) {
    throw await apiErrorFromResponse(response, { fallback: "Restoring the post failed" })
  }
  return response.json()
}

export async function deletePostPermanently(id: string | number): Promise<void> {
  const response = await authenticatedFetch(`/api/v1/posts/${id}/permanent`, { method: "DELETE" })
  if (!response.ok) {
    throw await apiErrorFromResponse(response, { fallback: "Deleting the post failed" })
  }
}

export type BulkAction = "publish" | "trash" | "restore" | "delete"

// One post's outcome in a bulk action: ok, or the status, code and message its single
// route would have answered.
export interface BulkPostResult {
  id: number
  ok: boolean
  post_status?: string
  status?: number
  code?: string
  error?: string
}

export interface BulkPostsResponse {
  action: BulkAction
  results: BulkPostResult[]
  succeeded: number
  failed: number
}

// POST /posts/bulk (#327): up to 100 posts, each checked on its own. A post that fails
// never stops the others; the answer has a result per post.
export async function bulkPosts(action: BulkAction, ids: number[]): Promise<BulkPostsResponse> {
  const response = await authenticatedFetch("/api/v1/posts/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ids }),
  })
  if (!response.ok) {
    throw await apiErrorFromResponse(response, { fallback: "The bulk action failed" })
  }
  return response.json()
}

// The posts list's Author filter (#327): everyone credited on a post the caller may read.
export interface CreditedAuthor {
  id: number
  username: string
  full_name: string
}

export async function getCreditedAuthors(params: { type?: string } = {}): Promise<CreditedAuthor[]> {
  const response = await apiCall(buildUrl("/posts/authors", params))
  return response.authors || []
}

export async function createPostMedia(postId: number, mediaId: number, order: number = 1): Promise<any> {
  const response = await authenticatedFetch(`/api/v1/posts/${postId}/media`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      media_id: mediaId,
      order: order
    }),
  })

  if (!response.ok) {
    throw await apiErrorFromResponse(response, { fallback: "Failed to link media to post" })
  }

  return response.json()
}
