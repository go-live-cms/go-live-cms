import type { User, UserSortOption, PaginationParams, ApiResponse } from "./types"
import { apiCall } from "../api"
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
