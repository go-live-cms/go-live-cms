import { apiCall } from "../api-core"

export interface Settings {
  id: number
  post_url_structure: "id" | "slug"
  site_title: string
  posts_per_page: number
  created_at: string
  changed_at: string
}

export interface UpdateSettingsRequest {
  post_url_structure?: "id" | "slug"
  site_title?: string
  posts_per_page?: number
}

export interface ExtensionSetting {
  key: string
  value: any
  extension_type: "plugin" | "theme"
  extension_id: string
  created_at: string
  changed_at: string
}

export interface UpsertExtensionSettingRequest {
  key: string
  value: any
  extension_type: "plugin" | "theme"
  extension_id: string
}

/**
 * Get current core settings
 */
export async function getSettings(token?: string): Promise<Settings> {
  const response = await apiCall("/settings", { token })
  return response
}

/**
 * Update core settings
 */
export async function updateSettings(data: UpdateSettingsRequest, token?: string): Promise<Settings> {
  const response = await apiCall("/settings", {
    method: "PUT",
    body: data,
    token,
  })
  return response
}

/**
 * Get an extension setting by key
 */
export async function getExtensionSetting(key: string, token?: string): Promise<ExtensionSetting> {
  const response = await apiCall(`/extension-settings/${encodeURIComponent(key)}`, { token })
  return response
}

/**
 * List all extension settings, optionally filtered by extension
 */
export async function listExtensionSettings(
  params?: {
    extension_type?: "plugin" | "theme"
    extension_id?: string
  },
  token?: string
): Promise<{ extension_settings: ExtensionSetting[]; count: number }> {
  const queryParams = new URLSearchParams()
  if (params?.extension_type) queryParams.set("extension_type", params.extension_type)
  if (params?.extension_id) queryParams.set("extension_id", params.extension_id)

  const url = `/extension-settings${queryParams.toString() ? `?${queryParams.toString()}` : ""}`
  const response = await apiCall(url, { token })
  return response
}

/**
 * Upsert (create or update) an extension setting
 */
export async function upsertExtensionSetting(
  data: UpsertExtensionSettingRequest,
  token?: string
): Promise<ExtensionSetting> {
  const response = await apiCall("/extension-settings", {
    method: "PUT",
    body: data,
    token,
  })
  return response
}

/**
 * Delete an extension setting
 */
export async function deleteExtensionSetting(key: string, token?: string): Promise<{ message: string }> {
  const response = await apiCall(`/extension-settings/${encodeURIComponent(key)}`, {
    method: "DELETE",
    token,
  })
  return response
}
