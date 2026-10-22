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

// A non-2xx API response. message is the API's {"error": ...} text when it
// sent one; status and retryAfterSeconds (from Retry-After, on a 429) let
// callers tell e.g. a wrong current password (403) from a rate limit.
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds: number | null = null
  ) {
    super(message)
    this.name = "ApiError"
  }
}

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
    throw new ApiError(`HTTP 401: ${await response.text()}`, 401)
  }

  if (!response.ok) {
    const text = await response.text()
    let message = `HTTP ${response.status}: ${text}`
    try {
      message = JSON.parse(text).error || `HTTP ${response.status}`
    } catch {
      // not JSON; keep the raw text
    }
    const retryAfter = Number.parseInt(response.headers.get("Retry-After") ?? "", 10)
    throw new ApiError(message, response.status, Number.isFinite(retryAfter) ? retryAfter : null)
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
