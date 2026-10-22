import type { Media, MediaSortOption, PaginationParams, ApiResponse } from "./types"
import { apiCall, authenticatedFetch, getMediaURL } from "../api"
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

export class MediaUploadError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = "MediaUploadError"
  }
}

// replaceMediaFile swaps the stored file of media `id` (POST /media/:id/replace).
// The media keeps its id, name, alt and description, and its URL: the file is
// replaced in place, so posts that embed it show the new one. The server
// requires the same file type as the current file.
//
// It uses XMLHttpRequest rather than fetch because fetch can't report upload
// progress. Like apiCall, a 401 gets one forced token refresh and a retry.
export async function replaceMediaFile(
  id: number,
  file: File,
  onProgress?: (fraction: number) => void
): Promise<{ media: Media }> {
  const { authManager } = await import("../auth")

  const send = (token: string | null) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open("POST", `/api/v1/media/${id}/replace`)
      xhr.withCredentials = true
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`)
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress?.(e.loaded / e.total)
      }
      xhr.onload = () => {
        let body: any = {}
        try {
          body = JSON.parse(xhr.responseText)
        } catch {}
        resolve({ status: xhr.status, body })
      }
      xhr.onerror = () => reject(new MediaUploadError("Network error while uploading", 0))
      const form = new FormData()
      form.append("file", file)
      xhr.send(form)
    })

  const token = authManager.getAccessToken()
  let res = await send(token)
  if (res.status === 401) {
    let refreshed = false
    try {
      const current = authManager.getAccessToken()
      refreshed = (!!current && current !== token) || (await authManager.forceRefresh())
    } catch {}
    if (refreshed) {
      onProgress?.(0)
      res = await send(authManager.getAccessToken())
    }
  }

  if (res.status < 200 || res.status >= 300) {
    throw new MediaUploadError(res.body?.error || `Replace failed (HTTP ${res.status})`, res.status)
  }
  return res.body
}

// getMediaPreviewURL is the media URL with a version taken from changed_at.
// Replace keeps the URL, and an <img> already on the page won't refetch a URL
// it has shown, so admin previews add this to pick up a replaced file. Use the
// plain getMediaURL for anything stored or copied.
export function getMediaPreviewURL(media: Pick<Media, "media_path" | "changed_at">): string {
  const url = getMediaURL(media.media_path)
  const version = Date.parse(media.changed_at)
  // changed_at defaults to 0001-01-01 until a row is first updated.
  if (!Number.isFinite(version) || version <= 0) return url
  return `${url}${url.includes("?") ? "&" : "?"}v=${version}`
}