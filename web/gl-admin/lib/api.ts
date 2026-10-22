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
import { apiErrorFromResponse } from "./api/errors"

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

// A non-2xx API response: readable message, plus status, code (the API's
// machine-readable {"code": ...}), retryAfterSeconds and serverMessage. Defined
// in ./api/errors; re-exported here for existing imports.
export { ApiError } from "./api/errors"

export async function apiCall(endpoint: string, options: ApiOptions = {}, isRetry = false): Promise<any> {
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
    // The server can reject a token the client still thinks is fresh (e.g.
    // it predates a password change), so a 401 always gets a real refresh
    // and one retry; the local expiry check is not consulted. Auth
    // endpoints are excluded: their 401s mean bad credentials, not a stale
    // token. If the refresh session is gone too, the refresh clears auth
    // and the user is sent to log in.
    if (!isRetry && !isServer && !endpoint.startsWith("/auth/")) {
      let refreshed = false
      try {
        // Another request may already have swapped in a new token.
        const current = authManager.getAccessToken()
        refreshed = (!!current && current !== authToken) || (await authManager.forceRefresh())
      } catch {}
      if (refreshed) {
        // Drop any caller-supplied token: it is the stale one.
        return apiCall(endpoint, { ...options, token: undefined }, true)
      }
    }
    throw await apiErrorFromResponse(response, { authEndpoint: endpoint.startsWith("/auth/") })
  }

  if (!response.ok) {
    throw await apiErrorFromResponse(response)
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
