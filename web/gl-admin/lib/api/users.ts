import type { User, UserSortOption, PaginationParams, ApiResponse } from "./types"
import { apiCall } from "../api"
import { buildUrl } from "./utils"

export async function getUsers(
  params: PaginationParams & { sort?: UserSortOption; search?: string } = {},
  token?: string
): Promise<ApiResponse<User>> {
  const url = buildUrl("/users", params)
  const response = await apiCall(url, { token })
  return {
    data: response.users || [],
    meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
  }
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

export async function deleteUser(id: string | number, token?: string): Promise<any> {
  return apiCall(`/users/${id}`, { method: "DELETE", token })
}
