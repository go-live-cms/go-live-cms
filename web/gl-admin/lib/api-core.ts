import type {
  User,
  Session,
  Post,
  PostType,
  Media,
  TaxonomyType,
  TaxonomyTerm,
  PostSortOption,
  MediaSortOption,
  TaxonomySortOption,
  PaginationParams,
  ApiResponse,
} from "./types"
import { SERVER_API_URL, SERVER_MEDIA_URL } from "./server-api-url"

const isServer = typeof window === "undefined"
const API_BASE = isServer ? SERVER_API_URL : "/api/v1"
const MEDIA_BASE = isServer ? SERVER_MEDIA_URL : ""


interface ApiOptions {
  token?: string
  method?: string
  body?: any
}

export function getMediaURL(mediaPath: string): string {
  if (mediaPath.startsWith("http")) {
    return mediaPath
  }

  const cleanPath = mediaPath.startsWith("/") ? mediaPath : `/${mediaPath}`
  return cleanPath
}

export async function apiCall(endpoint: string, options: ApiOptions = {}) {
  const { token, method = "GET", body } = options

  const config: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  }

  if (body) {
    config.body = JSON.stringify(body)
  }

  const url = `${API_BASE}${endpoint}`
  const response = await fetch(url, config)

  if (!response.ok) {
    const error = await response.text()
    try {
      const errorObj = JSON.parse(error)
      throw new Error(errorObj.error || `HTTP ${response.status}`)
    } catch {
      throw new Error(`HTTP ${response.status}: ${error}`)
    }
  }

  // If the response has no content, return an empty object
  const contentType = response.headers.get("content-type")
  if (!contentType || !contentType.includes("application/json")) {
    return {}
  }

  const text = await response.text()
  if (!text) {
    return {}
  }

  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

export async function authenticatedFetch(url: string, options: RequestInit = {}): Promise<Response> {
  // Import authManager dynamically to avoid circular dependency
  const { authManager } = await import("./auth")
  const auth = authManager.getState()

  const headers = new Headers(options.headers)

  if (auth.accessToken) {
    headers.set("Authorization", `Bearer ${auth.accessToken}`)
  }

  return fetch(url, {
    ...options,
    headers,
  })
}

export default {
  getMediaURL,
  apiCall,
  authenticatedFetch,
}
