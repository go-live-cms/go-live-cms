import type {
  Post,
  PostSortOption,
  PostStatusCounts,
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

// The posts list's search box (#145): the full-text index, with the list's type, status
// and owner filters, best match first. Rows are shaped like getPosts' with_meta rows.
export async function searchPosts(
  params: PaginationParams & { q: string; type?: string; status?: string; user_id?: string | number }
): Promise<ApiResponse<Post>> {
  const response = await apiCall(buildUrl("/posts/search", params))
  return {
    data: response.posts || [],
    meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
  }
}

// How many posts have each status, with the list's type and owner filters (#340).
export async function getPostCounts(
  params: { type?: string; user_id?: string | number } = {}
): Promise<PostStatusCounts> {
  const response = await apiCall(buildUrl("/posts/counts", params))
  return { counts: response.counts || {}, total: response.total || 0 }
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

export async function deletePost(id: string | number): Promise<any> {
  const response = await authenticatedFetch(`/api/v1/posts/${id}`, {
    method: "DELETE",
  })

  if (!response.ok) {
    throw await apiErrorFromResponse(response, { fallback: "Delete post failed" })
  }

  return response.json()
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
