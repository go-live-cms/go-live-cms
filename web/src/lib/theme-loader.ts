/**
 * Theme Loader Utility
 *
 * Handles theme resolution, loading, and parent/child theme inheritance.
 */

import type { ThemeConfig } from "../../themes/default/theme.config"
import { getActiveTheme } from "./api"
import { log } from "./log"

export interface ThemeInfo {
  id: string
  name: string
  version: string
  parent?: string
  active: boolean
}

/**
 * Get the active theme ID from database
 */
export async function getActiveThemeId(): Promise<string> {
  try {
    const theme = await getActiveTheme()
    return theme.slug
  } catch (error) {
    log.error("active_theme_fetch_failed", { fallback: "default", error })
    return "default"
  }
}

/**
 * Load theme configuration
 */
export async function loadThemeConfig(themeId: string): Promise<ThemeConfig> {
  try {
    const config = await import(`../../themes/${themeId}/theme.config.ts`)
    return config.default || config.themeConfig
  } catch (error) {
    log.error("theme_config_load_failed", { theme: themeId, error })
    throw new Error(`Theme not found: ${themeId}`)
  }
}

/**
 * Resolve theme file path with parent theme fallback support
 *
 * Resolution order:
 * 1. Child theme file (if exists)
 * 2. Parent theme file (if parent exists)
 * 3. Throw error if not found
 *
 * @param path - Relative path within theme (e.g., 'layouts/post/default.astro')
 * @param themeId - Active theme ID
 * @returns Absolute path to the file
 */
export async function resolveThemeFile(path: string, themeId: string): Promise<string> {
  const config = await loadThemeConfig(themeId)

  // Try child theme first
  const childPath = `/themes/${themeId}/${path}`

  // For now, we'll just return the path
  // In Phase 2, we can add actual file existence checking
  // and parent theme fallback

  if (config.parent) {
    // TODO: Phase 2 - Implement parent theme fallback
    // const parentPath = `/themes/${config.parent}/${path}`
    // if (fileExists(parentPath)) return parentPath
  }

  return childPath
}

/**
 * Resolve layout component based on post type and layout variant
 *
 * @param postType - 'post' or 'page'
 * @param variant - Layout variant (e.g., 'default', 'sidebar', 'wide')
 * @returns Layout component path
 */
export async function resolveLayoutPath(postType: string, variant: string = "default"): Promise<string> {
  const themeId = await getActiveThemeId()
  const config = await loadThemeConfig(themeId)

  // Get layout configuration for this post type
  const layoutConfig = config.layouts[postType]?.[variant]

  if (!layoutConfig) {
    log.warn("layout_variant_not_found", { post_type: postType, variant, fallback: "default" })
    const defaultLayout = config.layouts[postType]?.default
    if (!defaultLayout) {
      throw new Error(`No default layout found for post type: ${postType}`)
    }
    return `/themes/${themeId}/${defaultLayout.file}`
  }

  return `/themes/${themeId}/${layoutConfig.file}`
}

/**
 * Get layout variant for a specific post from database settings
 */
export async function getPostLayoutVariant(post: any, postType: string): Promise<string> {
  try {
    const theme = await getActiveTheme()
    const layoutVariants = theme.settings?.layout_variants

    if (layoutVariants && layoutVariants[postType]) {
      return layoutVariants[postType]
    }

    return "default"
  } catch (error) {
    log.error("layout_variant_fetch_failed", { fallback: "default", error })
    return "default"
  }
}

/**
 * Get theme customizations
 * Phase 1: Returns empty object (no customizations yet)
 * Phase 2: Queries database for theme customizations
 */
export async function getThemeCustomizations(
  themeId: string,
  scope: string = "global",
  scopeId?: string
): Promise<Record<string, any>> {
  // TODO: Phase 2 - Query database for customizations
  return {}
}
