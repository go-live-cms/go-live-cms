import type { Session, ApiResponse } from "./types"
import { apiCall } from "../api"

// Authentication functions
export async function login(credentials: { username: string; password: string }): Promise<any> {
  return apiCall("/auth/login", { method: "POST", body: credentials })
}

export async function logout(data: { refresh_token: string | null }): Promise<any> {
  return apiCall("/auth/logout", { method: "POST", body: data })
}

export async function renewAccessToken(data: { refresh_token: string }): Promise<any> {
  return apiCall("/auth/refresh", { method: "POST", body: data })
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
