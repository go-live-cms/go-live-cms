import { apiCall } from "../api"

export interface Theme {
  id: number
  name: string
  slug: string
  description: string
  version: string
  author: string
  config: {
    layouts: {
      post: {
        default: string
        variants: string[]
      }
      page: {
        default: string
        variants: string[]
      }
    }
  }
  active: boolean
  created_at: string
  changed_at: string
}

export interface ActiveThemeWithSettings extends Theme {
  settings: {
    layout_variants?: {
      post: string
      page: string
    }
  }
}

export interface UpdateThemeSettingsRequest {
  settings: {
    layout_variants: {
      post: string
      page: string
    }
  }
}

/**
 * Get all available themes
 */
export async function getThemes(token?: string): Promise<Theme[]> {
  return apiCall("/themes", {
    method: "GET",
    token,
  })
}

/**
 * Get active theme with settings
 */
export async function getActiveTheme(token?: string): Promise<ActiveThemeWithSettings> {
  return apiCall("/themes/active", {
    method: "GET",
    token,
  })
}

/**
 * Activate a theme
 */
export async function activateTheme(themeId: number, token?: string): Promise<Theme> {
  return apiCall(`/themes/${themeId}/activate`, {
    method: "PUT",
    token,
  })
}

/**
 * Update active theme settings (layout variants)
 */
export async function updateActiveThemeSettings(
  settings: UpdateThemeSettingsRequest["settings"],
  token?: string
): Promise<{ theme_id: number; settings: any }> {
  return apiCall(`/themes/active/settings`, {
    method: "PUT",
    body: { settings },
    token,
  })
}
