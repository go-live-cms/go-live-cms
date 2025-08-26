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

const isDocker = typeof window === "undefined" || process.env.NODE_ENV === "development"
const API_BASE = isDocker && typeof window === "undefined" ? "http://api:8080/api/v1" : "/api/v1"
const MEDIA_BASE = isDocker && typeof window === "undefined" ? "http://api:8080" : ""

console.log("API_BASE:", API_BASE)
console.log("MEDIA_BASE:", MEDIA_BASE)

interface ApiOptions {
  token?: string
  method?: string
  body?: any
}

// Base API response interfaces
interface PostsResponse {
  posts?: Post[]
  meta?: {
    count: number
    limit: number
    offset: number
    total: number
  }
}

interface UsersResponse {
  users?: User[]
  meta?: {
    count: number
    limit: number
    offset: number
    total: number
  }
}

interface SessionsResponse {
  sessions?: Session[]
  meta?: {
    count: number
    limit: number
    offset: number
    total: number
  }
}

interface MediaResponse {
  media?: Media[]
  meta?: {
    count: number
    limit: number
    offset: number
    total: number
  }
}

interface TaxonomyTypesResponse {
  taxonomy_types?: TaxonomyType[]
  meta?: {
    count: number
    limit: number
    offset: number
    total: number
  }
}

interface PostTypesResponse {
  post_types?: PostType[]
  meta?: {
    count: number
    limit: number
    offset: number
    total: number
  }
}

interface TaxonomyTermsResponse {
  taxonomy_terms?: TaxonomyTerm[]
  meta?: {
    count: number
    limit: number
    offset: number
    total: number
  }
}

export function getMediaURL(mediaPath: string): string {
  if (mediaPath.startsWith("http")) {
    return mediaPath
  }

  const cleanPath = mediaPath.startsWith("/") ? mediaPath : `/${mediaPath}`
  return cleanPath
}

async function apiCall(endpoint: string, options: ApiOptions = {}) {
  const { token, method = "GET", body } = options

  const config: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  }

  if (body) {
    config.body = JSON.stringify(body)
  }

  try {
    const url = `${API_BASE}${endpoint}`
    console.log("Making API call to:", url)

    const response = await fetch(url, config)

    if (response.status === 401 && typeof window !== "undefined") {
      const { authManager } = await import("./auth.ts")
      const refreshed = await authManager.refreshAccessToken()

      if (refreshed) {
        const newToken = authManager.getAccessToken()
        if (newToken) {
          config.headers = {
            ...config.headers,
            Authorization: `Bearer ${newToken}`,
          }
          const retryResponse = await fetch(url, config)
          if (retryResponse.ok) {
            return retryResponse.json()
          }
        }
      }

      window.location.href = "/login"
      throw new Error("Authentication required")
    }

    if (!response.ok) {
      const errorText = await response.text()
      console.error("API Error Response:", errorText)
      throw new Error(`API Error: ${response.status} ${response.statusText}`)
    }

    return response.json()
  } catch (error) {
    console.error("API call failed:", error)
    throw error
  }
}

async function authenticatedFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const { authManager } = await import("./auth.ts")
  let token = authManager.getAccessToken()

  const makeRequest = async (authToken: string) => {
    return fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${authToken}`,
      },
    })
  }

  let response = await makeRequest(token!)

  if (response.status === 401 && typeof window !== "undefined") {
    console.log("Token expired, attempting refresh...")

    const refreshed = await authManager.refreshAccessToken()

    if (refreshed) {
      const newToken = authManager.getAccessToken()
      if (newToken) {
        console.log("Token refreshed, retrying request...")
        response = await makeRequest(newToken)
      }
    }

    if (response.status === 401) {
      window.location.href = "/login"
      throw new Error("Authentication required")
    }
  }

  return response
}

function buildQueryString(params: Record<string, any>): string {
  const filtered = Object.entries(params)
    .filter(([_, v]) => v !== undefined && v !== null && v !== "")
    .reduce((acc, [k, v]) => {
      acc[k] = String(v)
      return acc
    }, {} as Record<string, string>)

  return new URLSearchParams(filtered).toString()
}

export const auth = {
  login: (credentials: { username: string; password: string }) =>
    apiCall("/auth/login", { method: "POST", body: credentials }),

  renewAccessToken: (data: { refresh_token: string }) => apiCall("/auth/refresh", { method: "POST", body: data }),

  logout: (data: { refresh_token: string | null }) => apiCall("/auth/logout", { method: "POST", body: data }),
}

export const sessions = {
  getAll: async (token?: string): Promise<ApiResponse<Session>> => {
    const response: SessionsResponse = await apiCall("/sessions", { token })

    return {
      data: response.sessions || [],
      meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
    }
  },

  block: async (sessionId: string, token?: string) => {
    return apiCall("/sessions/block", {
      method: "PUT",
      body: { session_id: sessionId },
      token,
    })
  },
}

export const posts = {
  getAll: async (
    params: {
      limit?: number
      offset?: number
      type?: string
      user_id?: number
      search?: string
      sort?: PostSortOption
      status?: string
      with_meta?: boolean
    } = {}
  ): Promise<ApiResponse<Post>> => {
    const queryString = buildQueryString(params)
    const url = queryString ? `/posts?${queryString}` : "/posts"
    const response: PostsResponse = await apiCall(url)

    return {
      data: response.posts || [],
      meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
    }
  },

  getById: async (id: string | number): Promise<{ post: Post }> => {
    return apiCall(`/posts/${id}`)
  },

  getByUser: async (
    userId: string | number,
    params: PaginationParams & { sort?: PostSortOption } = {}
  ): Promise<ApiResponse<Post>> => {
    const queryString = buildQueryString(params)
    const url = queryString ? `/posts/user/${userId}?${queryString}` : `/posts/user/${userId}`
    const response: PostsResponse = await apiCall(url)

    return {
      data: response.posts || [],
      meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
    }
  },

  getByType: async (
    type: string,
    params: PaginationParams & { sort?: PostSortOption } = {}
  ): Promise<ApiResponse<Post>> => {
    const queryString = buildQueryString(params)
    const url = queryString ? `/posts/type/${type}?${queryString}` : `/posts/type/${type}`
    const response: PostsResponse = await apiCall(url)

    return {
      data: response.posts || [],
      meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
    }
  },

  getTaxonomies: async (postId: string | number): Promise<{ taxonomy_terms: TaxonomyTerm[] }> => {
    return apiCall(`/posts/${postId}/taxonomies`)
  },

  getWithMeta: async (postId: string | number) => {
    return apiCall(`/posts/${postId}/meta`)
  },

  create: async (data: Partial<Post>, token?: string) => {
    return apiCall("/posts", { method: "POST", body: data, token })
  },

  update: async (id: string | number, data: Partial<Post>, token?: string) => {
    return apiCall(`/posts/${id}`, { method: "PUT", body: data, token })
  },

  delete: async (id: string | number, token?: string) => {
    return apiCall(`/posts/${id}`, { method: "DELETE", token })
  },
}

export const users = {
  getAll: async (
    params: PaginationParams & { sort?: string; search?: string } = {},
    token?: string
  ): Promise<ApiResponse<User>> => {
    const queryString = buildQueryString(params)
    const url = queryString ? `/users?${queryString}` : "/users"
    const response: UsersResponse = await apiCall(url, { token })

    return {
      data: response.users || [],
      meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
    }
  },

  getById: async (id: string | number): Promise<{ user: User }> => {
    return apiCall(`/users/${id}`)
  },

  getByUsername: async (username: string): Promise<{ user: User }> => {
    return apiCall(`/users/username/${username}`)
  },

  getByEmail: async (email: string, token?: string): Promise<{ user: User }> => {
    return apiCall(`/users/email/${email}`, { token })
  },

  create: async (data: Partial<User>, token?: string) => {
    return apiCall("/users", { method: "POST", body: data, token })
  },

  update: async (id: string | number, data: Partial<User>, token?: string) => {
    return apiCall(`/users/${id}`, { method: "PUT", body: data, token })
  },

  delete: async (id: string | number, token?: string) => {
    return apiCall(`/users/${id}`, { method: "DELETE", token })
  },
}

export const media = {
  getAll: async (
    params: {
      limit?: number
      offset?: number
      type?: string
      user_id?: number
      search?: string
      sort?: MediaSortOption
      token?: string
    } = {}
  ): Promise<ApiResponse<Media>> => {
    const queryString = buildQueryString(params)
    const url = queryString ? `/media?${queryString}` : "/media"
    const response: MediaResponse = await apiCall(url, { token: params.token })

    return {
      data: response.media || [],
      meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
    }
  },

  search: async (params: {
    q: string
    limit?: number
    offset?: number
    type?: string
    user_id?: number
    sort?: MediaSortOption
  }): Promise<ApiResponse<Media>> => {
    const queryString = buildQueryString(params)
    const response: MediaResponse = await apiCall(`/media/search?${queryString}`)

    return {
      data: response.media || [],
      meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
    }
  },

  getById: async (id: string | number): Promise<{ media: Media }> => {
    return apiCall(`/media/${id}`)
  },

  getByUser: async (
    userId: string | number,
    params: PaginationParams & { sort?: MediaSortOption } = {}
  ): Promise<ApiResponse<Media>> => {
    const queryString = buildQueryString(params)
    const url = queryString ? `/media/user/${userId}?${queryString}` : `/media/user/${userId}`
    const response: MediaResponse = await apiCall(url)

    return {
      data: response.media || [],
      meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
    }
  },

  getByPost: async (postId: string | number): Promise<ApiResponse<Media>> => {
    const response: MediaResponse = await apiCall(`/media/post/${postId}`)

    return {
      data: response.media || [],
      meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
    }
  },

  getPopular: async (params: PaginationParams = {}): Promise<ApiResponse<Media>> => {
    const queryString = buildQueryString(params)
    const url = queryString ? `/media/popular?${queryString}` : "/media/popular"
    const response: MediaResponse = await apiCall(url)

    return {
      data: response.media || [],
      meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
    }
  },

  create: async (formData: FormData) => {
    try {
      const response = await authenticatedFetch(`${API_BASE}/media`, {
        method: "POST",
        body: formData,
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || "Upload failed")
      }

      return response.json()
    } catch (error) {
      console.error("Upload error:", error)
      throw error
    }
  },

  createBatch: async (formData: FormData) => {
    try {
      const response = await authenticatedFetch(`${API_BASE}/media/batch`, {
        method: "POST",
        body: formData,
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || "Batch upload failed")
      }

      return response.json()
    } catch (error) {
      console.error("Batch upload error:", error)
      throw error
    }
  },

  update: async (id: number, data: { name?: string; description?: string; alt?: string }) => {
    try {
      const response = await authenticatedFetch(`${API_BASE}/media/${id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || "Update failed")
      }

      return response.json()
    } catch (error) {
      console.error("Update error:", error)
      throw error
    }
  },

  delete: async (id: number) => {
    try {
      const response = await authenticatedFetch(`${API_BASE}/media/${id}`, {
        method: "DELETE",
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || "Delete failed")
      }

      return response.json()
    } catch (error) {
      console.error("Delete error:", error)
      throw error
    }
  },
}

export const postTypes = {
  getAll: async (): Promise<ApiResponse<PostType>> => {
    const response: PostTypesResponse = await apiCall("/post-types")

    return {
      data: response.post_types || [],
      meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
    }
  },

  getByName: async (name: string): Promise<{ post_type: PostType }> => {
    return apiCall(`/post-types/${name}`)
  },
}

export const taxonomyTypes = {
  getAll: async (): Promise<ApiResponse<TaxonomyType>> => {
    const response: TaxonomyTypesResponse = await apiCall("/taxonomy-types")

    return {
      data: response.taxonomy_types || [],
      meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
    }
  },

  getByName: async (name: string): Promise<{ taxonomy_type: TaxonomyType }> => {
    return apiCall(`/taxonomy-types/${name}`)
  },

  create: async (
    data: {
      name: string
      label: string
      description?: string
      hierarchical?: boolean
      public?: boolean
      show_ui?: boolean
      show_in_menu?: boolean
    },
    token?: string
  ) => {
    return apiCall("/taxonomy-types", { method: "POST", body: data, token })
  },
}

export const taxonomyTerms = {
  getAll: async (params: {
    type: string
    limit?: number
    offset?: number
    sort?: TaxonomySortOption
    parent_id?: number | null
    search?: string
  }): Promise<ApiResponse<TaxonomyTerm>> => {
    const queryString = buildQueryString(params)
    const response: TaxonomyTermsResponse = await apiCall(`/taxonomy-terms/type/${params.type}?${queryString}`)

    return {
      data: response.taxonomy_terms || [],
      meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
    }
  },

  search: async (params: {
    type: string
    q: string
    limit?: number
    offset?: number
  }): Promise<ApiResponse<TaxonomyTerm>> => {
    const queryString = buildQueryString(params)
    const response: TaxonomyTermsResponse = await apiCall(`/taxonomy-terms/search?${queryString}`)

    return {
      data: response.taxonomy_terms || [],
      meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
    }
  },

  getPopular: async (params: { type: string; limit?: number }): Promise<ApiResponse<TaxonomyTerm>> => {
    const queryString = buildQueryString(params)
    const response: TaxonomyTermsResponse = await apiCall(`/taxonomy-terms/popular?${queryString}`)

    return {
      data: response.taxonomy_terms || [],
      meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
    }
  },

  getById: async (id: string | number): Promise<{ taxonomy_term: TaxonomyTerm }> => {
    return apiCall(`/taxonomy-terms/${id}`)
  },

  getBySlug: async (slug: string): Promise<{ taxonomy_term: TaxonomyTerm }> => {
    return apiCall(`/taxonomy-terms/slug/${slug}`)
  },

  getPosts: async (
    termId: string | number,
    params: PaginationParams & { sort?: PostSortOption } = {}
  ): Promise<ApiResponse<Post>> => {
    const queryString = buildQueryString(params)
    const url = queryString ? `/taxonomy-terms/${termId}/posts?${queryString}` : `/taxonomy-terms/${termId}/posts`
    const response: PostsResponse = await apiCall(url)

    return {
      data: response.posts || [],
      meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
    }
  },

  create: async (
    data: {
      name: string
      slug?: string
      description?: string
      taxonomy_type_id: number
      parent_id?: number
      sort_order?: number
      meta?: Record<string, any>
    },
    token?: string
  ) => {
    return apiCall("/taxonomy-terms", { method: "POST", body: data, token })
  },

  update: async (
    id: string | number,
    data: {
      name?: string
      slug?: string
      description?: string
      parent_id?: number
      sort_order?: number
      meta?: Record<string, any>
    },
    token?: string
  ) => {
    return apiCall(`/taxonomy-terms/${id}`, { method: "PUT", body: data, token })
  },

  delete: async (id: string | number, force?: boolean, token?: string) => {
    const query = force ? "?force=true" : ""
    return apiCall(`/taxonomy-terms/${id}${query}`, { method: "DELETE", token })
  },
}

// Legacy taxonomies API (for backward compatibility) TODO: -- delete once we've implemented the new API
export const taxonomies = {
  getAll: (params: { type?: string } = {}) => {
    if (params.type) {
      return taxonomyTerms.getAll({ type: params.type })
    }
    return taxonomyTypes.getAll()
  },

  getById: (id: string | number) => taxonomyTerms.getById(id),

  getPopular: (params: { type?: string; limit?: number } = {}) => {
    if (params.type) {
      return taxonomyTerms.getPopular({ type: params.type, limit: params.limit })
    }
    throw new Error("Type parameter is required for popular taxonomies")
  },

  search: (query: string, type?: string) => {
    if (type) {
      return taxonomyTerms.search({ type, q: query })
    }
    throw new Error("Type parameter is required for taxonomy search")
  },
}

export const health = {
  check: () => apiCall("/health", { method: "GET" }),
}

// For backward compatibility, export the old api object
export const api = {
  login: auth.login,
  renewAccessToken: auth.renewAccessToken,
  logout: auth.logout,
  getPosts: posts.getAll,
  getPost: posts.getById,
  getPostsByUser: posts.getByUser,
  getUsers: users.getAll,
  getUser: users.getById,
  getUserByUsername: users.getByUsername,
  getTaxonomies: taxonomies.getAll,
  getTaxonomy: taxonomies.getById,
  getPopularTaxonomies: taxonomies.getPopular,
  searchTaxonomies: taxonomies.search,
  getMedia: media.getAll,
  searchMedia: media.search,
  getMediaById: media.getById,
  getPopularMedia: media.getPopular,
  createMedia: media.create,
  createMediaBatch: media.createBatch,
  updateMedia: media.update,
  deleteMedia: media.delete,
  health: health.check,
}

// Export everything for easy access
export default {
  auth,
  sessions,
  posts,
  postTypes,
  users,
  media,
  taxonomyTypes,
  taxonomyTerms,
  taxonomies, // legacy
  health,

  // Utils
  getMediaURL,

  // Backward compatibility
  api,
}
