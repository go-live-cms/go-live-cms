import type { Media, MediaSortOption, PaginationParams, ApiResponse } from "./types"
import { apiCall, authenticatedFetch } from "../api"
import { buildUrl } from "./utils"
import type { Post } from "./types"

export interface MediaQueryParams extends PaginationParams {
  sort?: MediaSortOption
  search?: string
  type?: string // file type filter (image, video, etc.)
  user_id?: number
  with_counts?: boolean
}

export async function getMedia(params: MediaQueryParams = {}): Promise<ApiResponse<Media>> {
  const url = buildUrl("/media", params)
  const response = await apiCall(url)
  return {
    data: response.media || [],
    meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
  }
}

export async function searchMedia(params: {
  q: string
  limit?: number
  offset?: number
  type?: string
  user_id?: number
  sort?: MediaSortOption
}): Promise<ApiResponse<Media>> {
  const url = buildUrl("/media/search", params)
  const response = await apiCall(url)
  return {
    data: response.media || [],
    meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
  }
}

export async function getMediaById(id: string | number): Promise<{ media: Media }> {
  return apiCall(`/media/${id}`)
}

export async function getPopularMedia(params: PaginationParams = {}): Promise<ApiResponse<Media>> {
  const url = buildUrl("/media/popular", params)
  const response = await apiCall(url)
  return {
    data: response.media || [],
    meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
  }
}

export async function createMedia(formData: FormData, token?: string): Promise<any> {
  const response = await authenticatedFetch("/api/v1/media", {
    method: "POST",
    body: formData,
  })
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || "Upload failed")
  }
  return response.json()
}

export async function updateMedia(
  id: number,
  data: { name?: string; description?: string; alt?: string },
  token?: string
): Promise<any> {
  const response = await authenticatedFetch(`/api/v1/media/${id}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  })
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || "Update failed")
  }
  return response.json()
}

export async function deleteMedia(id: number, token?: string): Promise<any> {
  const response = await authenticatedFetch(`/api/v1/media/${id}`, {
    method: "DELETE",
  })
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || "Delete failed")
  }
  return response.json()
}

export async function getMediaPosts(mediaId: number): Promise<ApiResponse<Post>> {
  const response = await apiCall(`/media/${mediaId}/posts`)
  return {
    data: response.posts || [],
    meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
  }
}
