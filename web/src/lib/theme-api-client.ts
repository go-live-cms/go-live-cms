/**
 * Theme API Client
 *
 * Provides API methods for theme functions to interact with the Go Live CMS backend.
 */

import type { ThemeAPIClient } from "./theme-api"
import { SERVER_MEDIA_URL } from "../../gl-admin/lib/server-api-url"
import { log, requestIdHeaders } from "./log"

// API origin (no /api/v1), from the runtime SERVER_API_URL. The paths below add /api/v1.
const API_BASE_URL = SERVER_MEDIA_URL

export class ThemeAPIClientImpl implements ThemeAPIClient {
  private authToken: string | null

  constructor(authToken: string | null = null) {
    this.authToken = authToken
  }

  private getHeaders(): HeadersInit {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...requestIdHeaders(),
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
      log.error("theme_api_request_failed", { call: "getPosts", error })
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
      log.error("theme_api_request_failed", { call: "getPost", error })
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
      log.error("theme_api_request_failed", { call: "registerPostType", error })
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
      log.error("theme_api_request_failed", { call: "getTaxonomyTerms", error })
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
      log.error("theme_api_request_failed", { call: "getMedia", error })
      return []
    }
  }
}
