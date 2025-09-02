import type { Post, PostSortOption, PaginationParams, ApiResponse, TaxonomyTerm } from "./types"
import { apiCall, authenticatedFetch } from "../api"
import { buildUrl } from "./utils"

export interface PostQueryParams extends PaginationParams {
  sort?: PostSortOption
  type?: string // post type name
  status?: string
  with_meta?: boolean
}

export async function getPosts(params: PostQueryParams = {}): Promise<ApiResponse<Post>> {
  const url = buildUrl("/posts", params)
  const response = await apiCall(url)
  return {
    data: response.posts || [],
    meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
  }
}

export async function getPostById(id: string | number): Promise<{ post: Post }> {
  return apiCall(`/posts/${id}`)
}

export async function getPostsByUser(
  userId: string | number,
  params: PaginationParams & { sort?: PostSortOption } = {}
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
  params: PaginationParams & { sort?: PostSortOption } = {}
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

export async function createPost(data: Partial<Post>): Promise<any> {
  const response = await authenticatedFetch("/api/v1/posts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || "Create post failed")
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
    const error = await response.json()
    throw new Error(error.error || "Update post failed")
  }

  return response.json()
}

export async function deletePost(id: string | number): Promise<any> {
  const response = await authenticatedFetch(`/api/v1/posts/${id}`, {
    method: "DELETE",
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || "Delete post failed")
  }

  return response.json()
}
