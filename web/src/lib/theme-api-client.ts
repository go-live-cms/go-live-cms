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
   * Fetch a public post type's published posts (GET /public/posts), with their
   * published titles and excerpts. Themes render for anonymous visitors, so they
   * never read /api/v1/posts: that is the admin's working copy, drafts included,
   * and needs a sign-in (#393). `status` is accepted for older themes and ignored:
   * only published posts come back. `postType` defaults to "post".
   */
  async getPosts(params?: { postType?: string; status?: string; limit?: number; offset?: number }): Promise<any[]> {
    try {
      const queryParams = new URLSearchParams({ type: params?.postType || "post" })

      if (params?.limit) queryParams.append("limit", params.limit.toString())
      if (params?.offset) queryParams.append("offset", params.offset.toString())

      const url = `${API_BASE_URL}/public/posts?${queryParams.toString()}`
      const response = await fetch(url, {
        method: "GET",
        headers: this.getHeaders(),
      })

      if (!response.ok) {
        throw new Error(`Failed to fetch posts: ${response.statusText}`)
      }

      const body = await response.json()
      return Array.isArray(body?.posts) ? body.posts : []
    } catch (error) {
      log.error("theme_api_request_failed", { call: "getPosts", error })
      return []
    }
  }

  /**
   * Get a published post by ID (GET /public/posts/:id): `{ post, featured_image,
   * taxonomy_terms }`, or null for a draft, an archived post or an unknown id.
   */
  async getPost(id: number): Promise<any> {
    try {
      const url = `${API_BASE_URL}/public/posts/${encodeURIComponent(String(id))}`
      const response = await fetch(url, {
        method: "GET",
        headers: this.getHeaders(),
      })

      if (response.status === 404) return null
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
   * Get media items (GET /api/v1/media). The media library is the admin's (#393):
   * this needs the client's auth token and returns [] without one.
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
