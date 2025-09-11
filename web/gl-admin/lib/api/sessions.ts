import type { Session, ApiResponse } from "./types"
import { apiCall } from "../api"

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
    const error = await response.text()
    try {
      const errorObj = JSON.parse(error)
      throw new Error(errorObj.error || `HTTP ${response.status}`)
    } catch {
      throw new Error(`HTTP ${response.status}: ${error}`)
    }
  }

  return response.json()
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
    const error = await response.text()
    try {
      const errorObj = JSON.parse(error)
      throw new Error(errorObj.error || `HTTP ${response.status}`)
    } catch {
      throw new Error(`HTTP ${response.status}: ${error}`)
    }
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
