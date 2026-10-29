import type { PostType, ApiResponse } from "./types"
import { apiCall } from "../api"

export async function getPostTypes(): Promise<ApiResponse<PostType>> {
  const response = await apiCall("/post-types")
  return {
    data: response.post_types || [],
    meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
  }
}

export async function getPostTypeByName(name: string): Promise<{ post_type: PostType }> {
  return apiCall(`/post-types/${name}`)
}

// The fields POST and PUT /post-types share (api/post_types.go). Admin only.
export interface PostTypeInput {
  label: string
  description: string
  public: boolean
  hierarchical: boolean
  has_archive: boolean
  menu_position?: number
  supports: string[]
}

// Fired on window after a create or update, so the sidebar reloads its menu.
export const POST_TYPES_CHANGED = "gl:post-types-changed"

const changed = <T,>(result: T): T => {
  window.dispatchEvent(new Event(POST_TYPES_CHANGED))
  return result
}

export async function createPostType(data: PostTypeInput & { name: string }): Promise<{ post_type: PostType }> {
  return changed(await apiCall("/post-types", { method: "POST", body: data }))
}

export async function updatePostType(name: string, data: PostTypeInput): Promise<{ post_type: PostType }> {
  return changed(await apiCall(`/post-types/${encodeURIComponent(name)}`, { method: "PUT", body: data }))
}
