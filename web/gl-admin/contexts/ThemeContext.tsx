import React, { createContext, useContext, useState, useEffect } from "react"
import { registerThemeBlocks } from "../../src/components/blocks/registry"
import { registerThemeExtensions } from "../components/editor/utils/extensionRegistry"

interface ThemeContextValue {
  isThemeLoaded: boolean
  themeSlug: string
}

const ThemeContext = createContext<ThemeContextValue>({
  isThemeLoaded: false,
  themeSlug: "default",
})

export const useTheme = () => useContext(ThemeContext)

type ThemeConfigLoaders = Record<string, () => Promise<Record<string, any>>>

// The themes' theme.config.ts, resolved when the admin is built (#272), like the
// middleware's THEME_CONFIGS. Importing /themes/<slug>/theme.config.ts by URL only works
// under the dev server: the production image has no Vite, so that request 404s.
const THEME_CONFIGS: ThemeConfigLoaders = import.meta.glob("../../themes/*/theme.config.ts")

// The theme's config, or null when the theme isn't in this build.
export async function loadThemeConfig(slug: string, loaders: ThemeConfigLoaders = THEME_CONFIGS) {
  const load = loaders[`../../themes/${slug}/theme.config.ts`]
  if (!load) return null
  const module = await load()
  return module.themeConfig || module.default || null
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isThemeLoaded, setIsThemeLoaded] = useState(false)
  const [themeSlug, setThemeSlug] = useState("default")

  useEffect(() => {
    let cancelled = false

    async function loadTheme() {
      try {
        // Get active theme from window (injected by middleware)
        const slug = (window as any).__ACTIVE_THEME__ || "default"

        if (cancelled) return
        setThemeSlug(slug)

        const config = await loadThemeConfig(slug)
        if (!config) console.warn(`[ThemeProvider] Theme "${slug}" is not in this build`)

        if (config?.blocks && !cancelled) {
          console.log(`[ThemeProvider] Loading ${config.blocks.length} custom blocks from theme: ${slug}`)

          // Register extensions FIRST (before any editor is created)
          await registerThemeExtensions(slug, config.blocks)

          // Then register blocks
          await registerThemeBlocks(slug, config.blocks)
        }

        if (!cancelled) {
          console.log(`[ThemeProvider] Theme loaded: ${slug}`)
          setIsThemeLoaded(true)
        }
      } catch (error) {
        console.error("[ThemeProvider] Failed to load theme:", error)
        // Still set loaded to true to prevent blocking the app
        if (!cancelled) {
          setIsThemeLoaded(true)
        }
      }
    }

    loadTheme()

    return () => {
      cancelled = true
    }
  }, [])

  return <ThemeContext.Provider value={{ isThemeLoaded, themeSlug }}>{children}</ThemeContext.Provider>
}
