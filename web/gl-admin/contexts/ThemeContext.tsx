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

        // Dynamically import theme config
        const themeConfig = await import(/* @vite-ignore */ `/themes/${slug}/theme.config.ts`)
        const config = themeConfig.themeConfig || themeConfig.default

        if (config.blocks && !cancelled) {
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
