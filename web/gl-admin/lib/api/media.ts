import type { FocalPoint, Media, MediaSortOption, MediaVariantName, PaginationParams, ApiResponse } from "./types"
import { apiCall, authenticatedFetch, getMediaURL } from "../api"
import { apiErrorFromResponse, friendlyApiMessage } from "./errors"
import { buildUrl } from "./utils"
import type { MediaPostLink } from "../mediaLibrary"

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
    throw await apiErrorFromResponse(response, { fallback: "Upload failed" })
  }
  return response.json()
}

export async function updateMedia(
  id: number,
  // focal_point: null clears it; leave it out to keep it.
  data: { name?: string; description?: string; alt?: string; focal_point?: FocalPoint | null },
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
    throw await apiErrorFromResponse(response, { fallback: "Update failed" })
  }
  return response.json()
}

export async function deleteMedia(id: number, token?: string): Promise<any> {
  const response = await authenticatedFetch(`/api/v1/media/${id}`, {
    method: "DELETE",
  })
  if (!response.ok) {
    throw await apiErrorFromResponse(response, { fallback: "Delete failed" })
  }
  return response.json()
}

// getMediaPosts lists the posts linking media `mediaId` through post_media: its
// featured image (media_order 0) and the image blocks the collab store syncs (> 0).
// A post using it both ways has a row for each; see usedInRows in lib/mediaLibrary.ts.
export async function getMediaPosts(mediaId: number): Promise<MediaPostLink[]> {
  const response = await apiCall(`/media/${mediaId}/posts`)
  return response.posts || []
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
    const serverMessage = typeof res.body?.error === "string" ? res.body.error : null
    throw new MediaUploadError(friendlyApiMessage(res.status, { serverMessage, fallback: "Replace failed" }), res.status)
  }
  return res.body
}

// getMediaPreviewURL is the media URL with a version taken from changed_at.
// Replace keeps the URL, and an <img> already on the page won't refetch a URL
// it has shown, so admin previews add this to pick up a replaced file. Use the
// plain getMediaURL for anything stored or copied.
export function getMediaPreviewURL(media: Pick<Media, "media_path" | "changed_at">): string {
  return withVersion(getMediaURL(media.media_path), media.changed_at)
}

// Variant sizes from smallest to largest (#255).
const VARIANT_ORDER: MediaVariantName[] = ["thumb", "medium", "large"]

// getMediaVariantPreviewURL is getMediaPreviewURL for a resized copy: the
// requested variant, else the next larger one, else the original (images
// smaller than a size have no variant of it, and non-images have none). Use
// it for grids and pickers, which don't need the full-size file.
export function getMediaVariantPreviewURL(
  media: Pick<Media, "media_path" | "changed_at" | "variants">,
  size: MediaVariantName = "thumb"
): string {
  const variants = media.variants || {}
  for (const name of VARIANT_ORDER.slice(VARIANT_ORDER.indexOf(size))) {
    const variant = variants[name]
    if (variant?.path) return withVersion(getMediaURL(variant.path), media.changed_at)
  }
  return getMediaPreviewURL(media)
}

function withVersion(url: string, changedAt: string): string {
  const version = Date.parse(changedAt)
  // changed_at defaults to 0001-01-01 until a row is first updated.
  if (!Number.isFinite(version) || version <= 0) return url
  return `${url}${url.includes("?") ? "&" : "?"}v=${version}`
}