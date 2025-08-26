import type { Post, PostSortOption, PaginationParams, ApiResponse, TaxonomyTerm } from "./types"
import { apiCall } from "../api"
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

export async function createPost(data: Partial<Post>, token?: string): Promise<any> {
  return apiCall("/posts", { method: "POST", body: data, token })
}

export async function updatePost(id: string | number, data: Partial<Post>, token?: string): Promise<any> {
  return apiCall(`/posts/${id}`, { method: "PUT", body: data, token })
}

export async function deletePost(id: string | number, token?: string): Promise<any> {
  return apiCall(`/posts/${id}`, { method: "DELETE", token })
}
