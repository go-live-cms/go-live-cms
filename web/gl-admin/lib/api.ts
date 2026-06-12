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

const isDocker = typeof window === "undefined" || process.env.NODE_ENV === "development"
const _serverApiUrl = import.meta.env.SERVER_API_URL || "http://api:8080/api/v1"
const API_BASE = isDocker && typeof window === "undefined" ? _serverApiUrl : "/api/v1"
const MEDIA_BASE = isDocker && typeof window === "undefined" ? _serverApiUrl.replace(/\/api\/v1\/?$/, "") : ""

console.log("API_BASE:", API_BASE)
console.log("MEDIA_BASE:", MEDIA_BASE)

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

  // Import authManager dynamically to avoid circular dependency
  const { authManager } = await import("./auth")
  const auth = authManager.getState()

  // Use provided token or get from auth manager
  const authToken = token || auth.accessToken

  const config: RequestInit = {
    method,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(authToken && { Authorization: `Bearer ${authToken}` }),
    },
  }

  if (body) {
    config.body = JSON.stringify(body)
  }

  const url = `${API_BASE}${endpoint}`
  const response = await fetch(url, config)

  if (response.status === 401) {
    // Give authManager a chance to refresh or prompt login
    try {
      if (authManager && typeof authManager.refreshAccessToken === "function") {
        await authManager.refreshAccessToken()
      }
    } catch {}
    throw new Error(`HTTP 401: ${await response.text()}`)
  }

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

// Export everything for backward compatibility
export default {
  getMediaURL,
  apiCall,
  authenticatedFetch,
}
