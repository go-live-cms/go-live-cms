/**
 * Theme Settings Storage
 *
 * Wraps the extension_settings API to provide theme-specific namespaced storage.
 * Each theme stores data in the extension_settings table with:
 * - extension_type: 'theme'
 * - extension_id: theme slug
 * - key: theme:<slug>:<setting key> (the whole table's primary key, so the slug
 *   is what keeps two themes' settings apart; the API refuses any other shape)
 * - value: JSONB setting value
 *
 * These rows are publicly readable, so a theme must not store secrets here.
 * Plugins don't share this client: their settings go through admin-only routes.
 */

import type { ThemeSettings } from "./theme-api"
import { SERVER_MEDIA_URL } from "../../gl-admin/lib/server-api-url"
import { log, requestIdHeaders } from "./log"

// API origin (no /api/v1), from the runtime SERVER_API_URL. The paths below add /api/v1.
const API_BASE_URL = SERVER_MEDIA_URL

export class ThemeSettingsImpl implements ThemeSettings {
  private themeSlug: string
  private authToken: string | null

  constructor(themeSlug: string, authToken: string | null = null) {
    this.themeSlug = themeSlug
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

  private storedKey(key: string): string {
    return `theme:${this.themeSlug}:${key}`
  }

  private settingUrl(key: string): string {
    return `${API_BASE_URL}/api/v1/extension-settings/${encodeURIComponent(this.storedKey(key))}`
  }

  /**
   * Get a theme setting value
   */
  async get(key: string): Promise<any> {
    try {
      const response = await fetch(this.settingUrl(key), {
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
      log.error("theme_setting_request_failed", { op: "get", theme: this.themeSlug, setting: key, error })
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
          key: this.storedKey(key),
          value: value,
        }),
      })

      if (!response.ok) {
        throw new Error(`Failed to set setting: ${response.statusText}`)
      }
    } catch (error) {
      log.error("theme_setting_request_failed", { op: "set", theme: this.themeSlug, setting: key, error })
      throw error
    }
  }

  /**
   * Delete a theme setting
   */
  async delete(key: string): Promise<void> {
    try {
      const response = await fetch(this.settingUrl(key), {
        method: "DELETE",
        headers: this.getHeaders(),
      })

      if (!response.ok && response.status !== 404) {
        throw new Error(`Failed to delete setting: ${response.statusText}`)
      }
    } catch (error) {
      log.error("theme_setting_request_failed", { op: "delete", theme: this.themeSlug, setting: key, error })
      throw error
    }
  }

  /**
   * Get all theme settings, by the key each was set under
   */
  async getAll(): Promise<Record<string, any>> {
    try {
      const url = `${API_BASE_URL}/api/v1/extension-settings?extension_type=theme&extension_id=${encodeURIComponent(this.themeSlug)}`
      const response = await fetch(url, {
        method: "GET",
        headers: this.getHeaders(),
      })

      if (!response.ok) {
        throw new Error(`Failed to get settings: ${response.statusText}`)
      }

      const data: { extension_settings?: Array<{ key: string; value: any }> } = await response.json()

      const prefix = this.storedKey("")
      const result: Record<string, any> = {}
      for (const setting of data.extension_settings ?? []) {
        if (setting.key.startsWith(prefix)) {
          result[setting.key.slice(prefix.length)] = setting.value
        }
      }

      return result
    } catch (error) {
      log.error("theme_setting_request_failed", { op: "getAll", theme: this.themeSlug, error })
      return {}
    }
  }
}
