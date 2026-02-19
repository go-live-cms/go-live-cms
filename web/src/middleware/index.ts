import { defineMiddleware } from "astro:middleware"
import fs from "node:fs"
import path from "node:path"
import { getActiveTheme } from "../lib/api"
import { ThemeSettingsImpl } from "../lib/theme-settings"
import { ThemeAPIClientImpl } from "../lib/theme-api-client"
import { safeExecute } from "../lib/theme-api"
import type { ThemeFunctions, ThemeFunctionsContext } from "../lib/theme-api"

export const onRequest = defineMiddleware(async (context, next) => {
  const url = new URL(context.request.url)

  // Inject active theme metadata and assets into locals
  if (!context.locals.activeTheme) {
    try {
      const theme = await getActiveTheme()
      context.locals.activeTheme = theme.slug

      // WordPress-style: Load theme config to get registered assets
      try {
        const configPath = path.join(process.cwd(), "themes", theme.slug, "theme.config.ts")
        // Dynamic import of theme config
        const configModule = await import(`../../themes/${theme.slug}/theme.config.ts`)
        const themeConfig = configModule.themeConfig || configModule.default

        // Inject theme assets (styles and scripts)
        context.locals.themeAssets = themeConfig.assets || {}

        // Backward compatibility: fallback CSS path if no assets registered
        if (!themeConfig.assets?.styles?.length) {
          context.locals.themeCssPath = `/themes/${theme.slug}/styles/theme.css`
        }
      } catch (error) {
        console.error(`Failed to load theme config for ${theme.slug}:`, error)
        // Fallback to default CSS path
        context.locals.themeCssPath = `/themes/${theme.slug}/styles/theme.css`
      }

      // Phase 2: Load and execute theme functions.ts
      try {
        const functionsModule = await import(`../../themes/${theme.slug}/functions.ts`)
        const themeFunctions: ThemeFunctions = functionsModule.default || functionsModule.themeFunctions

        if (themeFunctions) {
          // Get auth token from cookies if available
          const authToken = context.cookies.get("auth_token")?.value || null

          // Create theme functions context
          const themeContext: ThemeFunctionsContext = {
            request: context.request,
            url: new URL(context.request.url),
            locals: context.locals,
            apiClient: new ThemeAPIClientImpl(authToken),
            settings: new ThemeSettingsImpl(theme.slug, authToken),
            themeSlug: theme.slug,
            user: context.locals.user || null,
          }

          // Execute setup hook (only if not already run)
          // Note: In production, setup should be called once during theme activation
          // For dev, we check a flag to avoid repeated execution
          if (themeFunctions.setup && !context.locals.themeSetupComplete) {
            await safeExecute(() => themeFunctions.setup!(themeContext), theme.slug, "setup")
            context.locals.themeSetupComplete = true
          }

          // Execute beforeRender hook on every request
          if (themeFunctions.beforeRender) {
            await safeExecute(() => themeFunctions.beforeRender!(themeContext), theme.slug, "beforeRender")
          }

          // Store theme functions for later use (e.g., content filtering)
          context.locals.themeFunctions = themeFunctions
          context.locals.themeContext = themeContext
        }
      } catch (error) {
        // functions.ts is optional - silently continue if not found
        if (error.code !== "ERR_MODULE_NOT_FOUND") {
          console.error(`Failed to load theme functions for ${theme.slug}:`, error)
        }
      }
    } catch (error) {
      console.error("Failed to get active theme, using default:", error)
      context.locals.activeTheme = "default"
      context.locals.themeCssPath = "/themes/default/styles/theme.css"
    }
  }

  // Serve theme assets (CSS, thumbnails, etc.)
  if (url.pathname.startsWith("/themes/")) {
    const themePath = path.join(process.cwd(), url.pathname)

    if (fs.existsSync(themePath)) {
      const fileContent = fs.readFileSync(themePath)
      const ext = path.extname(themePath).toLowerCase()

      const contentTypes: Record<string, string> = {
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
      }

      return new Response(fileContent, {
        status: 200,
        headers: {
          "Content-Type": contentTypes[ext] || "application/octet-stream",
          "Cache-Control": ext === ".css" ? "public, max-age=3600" : "public, max-age=86400",
        },
      })
    }
  }

  return next()
})
