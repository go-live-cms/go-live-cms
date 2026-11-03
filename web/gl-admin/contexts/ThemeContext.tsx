import React, { createContext, useContext, useState, useEffect } from "react"
import { editorBlockRegistry } from "../components/editor/blocks"
import { themeSlashBlocks } from "../lib/theme-blocks/editorBlocks"

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

        // The editor already has every installed theme block in its schema (built in,
        // #376); the active theme only decides which ones the slash menu offers.
        if (!cancelled) themeSlashBlocks(slug).forEach((block) => editorBlockRegistry.register(block))

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
