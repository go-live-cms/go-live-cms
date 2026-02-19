/**
 * Theme Settings Storage
 *
 * Wraps the extension_settings API to provide theme-specific namespaced storage.
 * Each theme stores data in the extension_settings table with:
 * - extension_type: 'theme'
 * - extension_id: theme slug
 * - key: setting key
 * - value: JSONB setting value
 */

import type { ThemeSettings } from "./theme-api"

const API_BASE_URL = import.meta.env.SERVER_API_URL || "http://localhost:8080"

export class ThemeSettingsImpl implements ThemeSettings {
  private themeSlug: string
  private authToken: string | null

  constructor(themeSlug: string, authToken: string | null = null) {
    this.themeSlug = themeSlug
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
   * Get a theme setting value
   */
  async get(key: string): Promise<any> {
    try {
      const url = `${API_BASE_URL}/api/v1/extension-settings/${this.themeSlug}:${key}`
      const response = await fetch(url, {
        method: "GET",
        headers: this.getHeaders(),
      })

      if (response.status === 404) {
        return null
      }

      if (!response.ok) {
        throw new Error(`Failed to get setting: ${response.statusText}`)
      }

      const data = await response.json()
      return data.value
    } catch (error) {
      console.error(`[ThemeSettings] Error getting ${key}:`, error)
      return null
    }
  }

  /**
   * Set a theme setting value
   */
  async set(key: string, value: any): Promise<void> {
    try {
      const url = `${API_BASE_URL}/api/v1/extension-settings`
      const response = await fetch(url, {
        method: "PUT",
        headers: this.getHeaders(),
        body: JSON.stringify({
          extension_type: "theme",
          extension_id: this.themeSlug,
          key: key,
          value: value,
        }),
      })

      if (!response.ok) {
        throw new Error(`Failed to set setting: ${response.statusText}`)
      }
    } catch (error) {
      console.error(`[ThemeSettings] Error setting ${key}:`, error)
      throw error
    }
  }

  /**
   * Delete a theme setting
   */
  async delete(key: string): Promise<void> {
    try {
      const url = `${API_BASE_URL}/api/v1/extension-settings/${this.themeSlug}:${key}`
      const response = await fetch(url, {
        method: "DELETE",
        headers: this.getHeaders(),
      })

      if (!response.ok && response.status !== 404) {
        throw new Error(`Failed to delete setting: ${response.statusText}`)
      }
    } catch (error) {
      console.error(`[ThemeSettings] Error deleting ${key}:`, error)
      throw error
    }
  }

  /**
   * Get all theme settings
   */
  async getAll(): Promise<Record<string, any>> {
    try {
      const url = `${API_BASE_URL}/api/v1/extension-settings?extension_type=theme&extension_id=${this.themeSlug}`
      const response = await fetch(url, {
        method: "GET",
        headers: this.getHeaders(),
      })

      if (!response.ok) {
        throw new Error(`Failed to get settings: ${response.statusText}`)
      }

      const data = await response.json()

      // Convert array of settings to key-value object
      const result: Record<string, any> = {}
      if (Array.isArray(data)) {
        for (const setting of data) {
          result[setting.key] = setting.value
        }
      }

      return result
    } catch (error) {
      console.error("[ThemeSettings] Error getting all settings:", error)
      return {}
    }
  }
}
