import type { User, UserSortOption, PaginationParams, ApiResponse } from "./types"
import { apiCall, authenticatedFetch } from "../api"
import { apiErrorFromResponse } from "./errors"
import { buildUrl } from "./utils"

// q searches name, username and email; role filters (admin only, #333).
export async function getUsers(
  params: PaginationParams & { sort?: UserSortOption; q?: string; role?: string } = {},
  token?: string
): Promise<ApiResponse<User>> {
  const url = buildUrl("/users", params)
  const response = await apiCall(url, { token })
  return {
    data: response.users || [],
    meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
  }
}

// The caller's own profile, read from the DB (current role, not the login-time one).
export async function getMe(token?: string): Promise<{ user: User }> {
  return apiCall("/users/me", { token })
}

export async function getUserById(id: string | number, token?: string): Promise<{ user: User }> {
  return apiCall(`/users/id/${id}`, { token })
}

export async function getUserByUsername(username: string): Promise<{ user: User }> {
  return apiCall(`/users/username/${username}`)
}

export async function getUserByEmail(email: string, token?: string): Promise<{ user: User }> {
  return apiCall(`/users/email/${email}`, { token })
}

export async function createUser(data: Partial<User>, token?: string): Promise<any> {
  return apiCall("/users", { method: "POST", body: data, token })
}

export async function updateUser(id: string | number, data: Partial<User>, token?: string): Promise<any> {
  return apiCall(`/users/${id}`, { method: "PUT", body: data, token })
}

// The last admin can't be demoted: ApiError code "last_admin" (409).
export async function changeUserRole(id: string | number, role: string): Promise<{ user: User }> {
  return apiCall(`/users/${id}/role`, { method: "PUT", body: { role } })
}

// Removes a member (#333); everything they own goes to transferToId. Codes:
// "last_admin", "cannot_remove_self" (409), "invalid_transfer_target" (400).
export async function deleteUser(id: string | number, transferToId: number): Promise<{ posts_reassigned: number }> {
  return apiCall(`/users/${id}`, { method: "DELETE", body: { transfer_to_id: transferToId } })
}

// Your avatar (#334): the API crops a square around focal (0..1 of the image as
// shown; the center without one), scales it and re-encodes it. Codes: avatar_type,
// avatar_unreadable, avatar_dimensions (400), avatar_too_large (413).
export async function uploadAvatar(file: Blob, focal?: { x: number; y: number } | null): Promise<{ user: User }> {
  const form = new FormData()
  form.append("file", file, file instanceof File ? file.name : "avatar")
  if (focal) {
    form.append("focal_x", String(focal.x))
    form.append("focal_y", String(focal.y))
  }
  const send = () => authenticatedFetch("/api/v1/users/me/avatar", { method: "PUT", body: form })
  let response = await send()
  if (response.status === 401) {
    // Like apiCall: the server may reject a token this tab still thinks is fresh.
    // One real refresh, then one retry (a FormData body can be sent again).
    const { authManager } = await import("../auth")
    if (await authManager.forceRefresh().catch(() => false)) response = await send()
  }
  if (!response.ok) {
    throw await apiErrorFromResponse(response, { fallback: "Upload failed" })
  }
  return response.json()
}

export async function removeAvatar(): Promise<{ user: User }> {
  return apiCall("/users/me/avatar", { method: "DELETE" })
}

// Asks for an email change (#334): the link goes to newEmail, and nothing changes
// until it is used. The same 202 whatever the address. Codes:
// current_password_incorrect (403), same_email (400); 429 shares the password
// change limit.
export async function requestEmailChange(currentPassword: string, newEmail: string): Promise<{ message: string; expires_in_seconds: number }> {
  return apiCall("/users/me/email", { method: "POST", body: { current_password: currentPassword, new_email: newEmail } })
}