import type { Post, PostSortOption, PaginationParams, ApiResponse } from "../../gl-admin/lib/api/types"

const isDocker = typeof window === "undefined" || process.env.NODE_ENV === "development"
const API_BASE = isDocker && typeof window === "undefined" ? "http://api:8080/api/v1" : "/api/v1"

console.log("Frontend API_BASE:", API_BASE)

interface ApiOptions {
  method?: string
  body?: any
}

export async function apiCall(endpoint: string, options: ApiOptions = {}) {
  const { method = "GET", body } = options

  const config: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
    },
  }

  if (body) {
    config.body = JSON.stringify(body)
  }

  const url = `${API_BASE}${endpoint}`
  console.log("Fetching from:", url)

  const response = await fetch(url, config)

  if (!response.ok) {
    const error = await response.text()
    try {
      const errorObj = JSON.parse(error)
      throw new Error(errorObj.error || `HTTP ${response.status}`)
    } catch {
      throw new Error(`HTTP ${response.status}: ${error}`)
    }
  }

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

export interface PostQueryParams extends PaginationParams {
  sort?: PostSortOption
  type?: string
  status?: string
  user_id?: string | number
  with_meta?: boolean
  meta_level?: string
}

export async function getPosts(params: PostQueryParams = {}): Promise<ApiResponse<Post>> {
  const searchParams = new URLSearchParams()

  if (params.limit) searchParams.set("limit", params.limit.toString())
  if (params.offset) searchParams.set("offset", params.offset.toString())
  if (params.sort) searchParams.set("sort", params.sort)
  if (params.type) searchParams.set("type", params.type)
  if (params.status) searchParams.set("status", params.status)
  if (params.user_id) searchParams.set("user_id", params.user_id.toString())
  if (params.with_meta) searchParams.set("with_meta", params.with_meta.toString())
  if (params.meta_level) searchParams.set("meta_level", params.meta_level)

  const queryString = searchParams.toString()
  const endpoint = `/posts${queryString ? `?${queryString}` : ""}`

  const response = await apiCall(endpoint)
  return {
    data: response.posts || [],
    meta: response.meta || { count: 0, limit: 20, offset: 0, total: 0 },
  }
}

export async function getPostById(id: string | number): Promise<{ post: Post }> {
  return apiCall(`/posts/${id}`)
}

export async function getPostBySlug(slug: string): Promise<{ post: Post }> {
  return apiCall(`/posts/slug/${slug}`)
}

export async function getSettings(): Promise<any> {
  return apiCall("/settings")
}

export async function getPostsByType(type: string, params: PostQueryParams = {}): Promise<ApiResponse<Post>> {
  return getPosts({ ...params, type })
}

export async function getPublishedPosts(params: PostQueryParams = {}): Promise<ApiResponse<Post>> {
  return getPosts({ ...params, status: "published" })
}
