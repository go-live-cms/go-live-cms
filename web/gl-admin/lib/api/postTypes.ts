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
