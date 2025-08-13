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

interface ApiResponse<T> {
  meta?: {
    count: number
    limit: number
    offset: number
    total: number
  }
  posts?: T[]
  taxonomies?: T[]
  media?: T[]
  users?: T[]
}

export function getMediaURL(mediaPath: string): string {
  if (mediaPath.startsWith("http")) {
    return mediaPath
  }

  const cleanPath = mediaPath.startsWith("/") ? mediaPath : `/${mediaPath}`

  return cleanPath
}

export async function apiCall(endpoint: string, options: ApiOptions = {}) {
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

export const api = {
  login: (credentials: { username: string; password: string }) =>
    apiCall("/auth/login", { method: "POST", body: credentials }),

  renewAccessToken: (data: { refresh_token: string }) => apiCall("/auth/refresh", { method: "POST", body: data }),

  logout: (data: { refresh_token: string }) => apiCall("/auth/logout", { method: "POST", body: data }),
  getPosts: async (query: Record<string, any> = {}) => {
    const queryString = new URLSearchParams(
      Object.entries(query)
        .filter(([_, v]) => v !== undefined && v !== null)
        .reduce((acc, [k, v]) => {
          acc[k] = String(v)
          return acc
        }, {} as Record<string, string>)
    ).toString()

    const response: ApiResponse<any> = await apiCall(`/posts?${queryString}`)
    return {
      data: response.posts || [],
      meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
    }
  },
  getPost: (id: string) => apiCall(`/posts/${id}`),
  getPostsByUser: (userId: string) => apiCall(`/posts/user/${userId}`),

  getUsers: async (token?: string) => {
    const response: ApiResponse<any> = await apiCall("/users", { token })
    return {
      data: response.users || [],
      meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
    }
  },
  getUser: (id: string) => apiCall(`/users/${id}`),
  getUserByUsername: (username: string) => apiCall(`/users/username/${username}`),

  getTaxonomies: async () => {
    const response: ApiResponse<any> = await apiCall("/taxonomies")
    return {
      data: response.taxonomies || [],
      meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
    }
  },
  getTaxonomy: (id: string) => apiCall(`/taxonomies/${id}`),
  getPopularTaxonomies: async () => {
    const response: ApiResponse<any> = await apiCall("/taxonomies/popular")
    return {
      data: response.taxonomies || [],
      meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
    }
  },
  searchTaxonomies: (query: string) => apiCall(`/taxonomies/search?q=${query}`),

  getMedia: async (token?: string) => {
    const response: ApiResponse<any> = await apiCall("/media", { token })
    return {
      data: response.media || [],
      meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
    }
  },
  getMediaById: (id: string) => apiCall(`/media/${id}`),
  getPopularMedia: async () => {
    const response: ApiResponse<any> = await apiCall("/media/popular")
    return {
      data: response.media || [],
      meta: response.meta || { count: 0, limit: 10, offset: 0, total: 0 },
    }
  },
  searchMedia: (query: string) => apiCall(`/media/search?q=${query}`),

  createMedia: async (formData: FormData) => {
    try {
      const response = await authenticatedFetch(`${API_BASE}/media`, {
        method: "POST",
        body: formData,
        // Don't set Content-Type for FormData
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

  // Media update - Simplified
  updateMedia: async (id: number, data: { name?: string; description?: string; alt?: string }) => {
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

  // Media delete - Simplified
  deleteMedia: async (id: number) => {
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

  health: () => apiCall("/health", { method: "GET" }),
}
