import type { Session, ApiResponse } from "./types"
import { apiCall } from "../api"
import { apiErrorFromResponse } from "./errors"

// Authentication functions
export async function login(credentials: { username: string; password: string }): Promise<any> {
  return apiCall("/auth/login", { method: "POST", body: credentials })
}

export async function logout(token?: string): Promise<any> {
  const url = `/api/v1/auth/logout`
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }

  if (token) {
    headers["Authorization"] = `Bearer ${token}`
  }

  const response = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers,
  })

  if (!response.ok) {
    throw await apiErrorFromResponse(response, { authEndpoint: true })
  }

  return response.json()
}

// A failed POST /auth/refresh. status tells a revoked session (401/409) apart
// from a rate limit (429, with retryAfterSeconds from Retry-After), which says
// nothing about the session.
export class RefreshError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds: number | null = null
  ) {
    super(message)
    this.name = "RefreshError"
  }
}

export async function renewAccessToken(): Promise<any> {
  const url = `/api/v1/auth/refresh`
  const response = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
  })

  if (!response.ok) {
    const text = await response.text()
    let message = `HTTP ${response.status}: ${text}`
    try {
      message = JSON.parse(text).error || `HTTP ${response.status}`
    } catch {
      // not JSON; keep the raw text
    }
    const retryAfter = Number.parseInt(response.headers.get("Retry-After") ?? "", 10)
    throw new RefreshError(message, response.status, Number.isFinite(retryAfter) ? retryAfter : null)
  }

  return response.json()
}

// Session management functions
export async function getSessions(token?: string): Promise<ApiResponse<Session>> {
  const response = await apiCall("/sessions", { token })
  return {
    data: response.sessions || [],
    meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
  }
}

export async function blockSession(sessionId: string, token?: string): Promise<any> {
  return apiCall("/sessions/block", {
    method: "PUT",
    body: { session_id: sessionId },
    token,
  })
}
