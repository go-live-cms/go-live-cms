/**
 * Theme API Client
 *
 * Provides API methods for theme functions to interact with the Go Live CMS backend.
 */

import type { ThemeAPIClient } from "./theme-api"

const API_BASE_URL = import.meta.env.SERVER_API_URL || "http://localhost:8080"

export class ThemeAPIClientImpl implements ThemeAPIClient {
  private authToken: string | null

  constructor(authToken: string | null = null) {
    this.authToken = authToken
  }

  private getHeaders(): HeadersInit {
    const headers: HeadersInit = {
      "Content-Type": "application/json",
    }

    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`
    }

    return headers
  }

  /**
   * Fetch posts with optional filters
   */
  async getPosts(params?: { postType?: string; status?: string; limit?: number; offset?: number }): Promise<any[]> {
    try {
      const queryParams = new URLSearchParams()

      if (params?.postType) queryParams.append("post_type", params.postType)
      if (params?.status) queryParams.append("status", params.status)
      if (params?.limit) queryParams.append("limit", params.limit.toString())
      if (params?.offset) queryParams.append("offset", params.offset.toString())

      const url = `${API_BASE_URL}/api/v1/posts${queryParams.toString() ? "?" + queryParams.toString() : ""}`
      const response = await fetch(url, {
        method: "GET",
        headers: this.getHeaders(),
      })

      if (!response.ok) {
        throw new Error(`Failed to fetch posts: ${response.statusText}`)
      }

      return await response.json()
    } catch (error) {
      console.error("[ThemeAPIClient] Error fetching posts:", error)
      return []
    }
  }

  /**
   * Get a single post by ID
   */
  async getPost(id: number): Promise<any> {
    try {
      const url = `${API_BASE_URL}/api/v1/posts/${id}`
      const response = await fetch(url, {
        method: "GET",
        headers: this.getHeaders(),
      })

      if (!response.ok) {
        throw new Error(`Failed to fetch post: ${response.statusText}`)
      }

      return await response.json()
    } catch (error) {
      console.error("[ThemeAPIClient] Error fetching post:", error)
      return null
    }
  }

  /**
   * Register a custom post type
   */
  async registerPostType(config: {
    name: string
    slug: string
    description?: string
    icon?: string
    supports?: string[]
  }): Promise<void> {
    try {
      const url = `${API_BASE_URL}/api/v1/post-types`
      const response = await fetch(url, {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify(config),
      })

      if (!response.ok) {
        throw new Error(`Failed to register post type: ${response.statusText}`)
      }
    } catch (error) {
      console.error("[ThemeAPIClient] Error registering post type:", error)
      throw error
    }
  }

  /**
   * Get taxonomy terms
   */
  async getTaxonomyTerms(taxonomyType: string): Promise<any[]> {
    try {
      const url = `${API_BASE_URL}/api/v1/taxonomy/types/${taxonomyType}/terms`
      const response = await fetch(url, {
        method: "GET",
        headers: this.getHeaders(),
      })

      if (!response.ok) {
        throw new Error(`Failed to fetch taxonomy terms: ${response.statusText}`)
      }

      return await response.json()
    } catch (error) {
      console.error("[ThemeAPIClient] Error fetching taxonomy terms:", error)
      return []
    }
  }

  /**
   * Get media items
   */
  async getMedia(params?: { limit?: number; offset?: number }): Promise<any[]> {
    try {
      const queryParams = new URLSearchParams()

      if (params?.limit) queryParams.append("limit", params.limit.toString())
      if (params?.offset) queryParams.append("offset", params.offset.toString())

      const url = `${API_BASE_URL}/api/v1/media${queryParams.toString() ? "?" + queryParams.toString() : ""}`
      const response = await fetch(url, {
        method: "GET",
        headers: this.getHeaders(),
      })

      if (!response.ok) {
        throw new Error(`Failed to fetch media: ${response.statusText}`)
      }

      return await response.json()
    } catch (error) {
      console.error("[ThemeAPIClient] Error fetching media:", error)
      return []
    }
  }
}
