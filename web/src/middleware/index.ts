import { defineMiddleware } from "astro:middleware"
import fs from "node:fs"
import path from "node:path"
import { getActiveTheme } from "../lib/api"
import { ThemeSettingsImpl } from "../lib/theme-settings"
import { ThemeAPIClientImpl } from "../lib/theme-api-client"
import { safeExecute } from "../lib/theme-api"
import type { ThemeFunctions, ThemeFunctionsContext } from "../lib/theme-api"
import { applyAdminCsp, isAccountPagePath, isAdminPath } from "./csp"
import { isApiProxyPath, proxyToApi } from "./apiProxy"
import { shouldNoindex } from "../lib/seo"
import { SERVER_MEDIA_URL } from "../../gl-admin/lib/server-api-url"
import { hocuspocusUrl, usesHocuspocus } from "../../gl-admin/lib/collaboration/backend"

// Themes are bundled at build time (#272): Vite resolves these globs when the image is
// built (lazily: nothing loads until called), so a theme copied in later has no entry.
// Keyed by path, e.g. "../../themes/default/theme.config.ts".
const THEME_CONFIGS = import.meta.glob<Record<string, any>>("../../themes/*/theme.config.ts")
const THEME_FUNCTIONS = import.meta.glob<Record<string, any>>("../../themes/*/functions.ts")

export const onRequest = defineMiddleware(async (context, next) => {
  const url = new URL(context.request.url)

  // Production only: in dev the Vite proxy handles these before Astro (apiProxy.ts).
  if (!import.meta.env.DEV && isApiProxyPath(url.pathname)) {
    let clientAddress: string | undefined
    try {
      clientAddress = context.clientAddress
    } catch {
      // Not available for prerendered routes; forward without it.
    }
    return proxyToApi(context.request, clientAddress, SERVER_MEDIA_URL)
  }

  // Inject active theme metadata and assets into locals
  if (!context.locals.activeTheme) {
    try {
      const theme = await getActiveTheme()
      context.locals.activeTheme = theme.slug

      // WordPress-style: Load theme config to get registered assets
      try {
        const loadConfig = THEME_CONFIGS[`../../themes/${theme.slug}/theme.config.ts`]
        if (!loadConfig) {
          console.error(
            `Theme "${theme.slug}" is not in this build. Themes are bundled at build time: ` +
              `add it to web/themes and rebuild the web and api images. Using its CSS only.`,
          )
          context.locals.themeCssPath = `/themes/${theme.slug}/styles/theme.css`
        } else {
          const configModule = await loadConfig()
          const themeConfig = configModule.themeConfig || configModule.default

          // Inject theme assets (styles and scripts)
          context.locals.themeAssets = themeConfig.assets || {}

          // Backward compatibility: fallback CSS path if no assets registered
          if (!themeConfig.assets?.styles?.length) {
            context.locals.themeCssPath = `/themes/${theme.slug}/styles/theme.css`
          }
        }
      } catch (error) {
        console.error(`Failed to load theme config for ${theme.slug}:`, error)
        // Fallback to default CSS path
        context.locals.themeCssPath = `/themes/${theme.slug}/styles/theme.css`
      }

      // Phase 2: Load and execute theme functions.ts
      try {
        // functions.ts is optional: no glob entry means the theme has none.
        const loadFunctions = THEME_FUNCTIONS[`../../themes/${theme.slug}/functions.ts`]
        const functionsModule = loadFunctions ? await loadFunctions() : {}
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

  // Serve theme assets (CSS, thumbnails, etc.). Only these extensions: themes/
  // also holds source (theme.config.ts, functions.ts, .astro layouts).
  if (url.pathname.startsWith("/themes/")) {
    const themePath = path.join(process.cwd(), url.pathname)
    const ext = path.extname(themePath).toLowerCase()

    const contentTypes: Record<string, string> = {
      ".css": "text/css",
      ".js": "text/javascript",
      ".svg": "image/svg+xml",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    }

    if (contentTypes[ext] && fs.existsSync(themePath)) {
      const fileContent = fs.readFileSync(themePath)

      return new Response(fileContent, {
        status: 200,
        headers: {
          "Content-Type": contentTypes[ext],
          "Cache-Control": ext === ".css" ? "public, max-age=3600" : "public, max-age=86400",
        },
      })
    }
  }

  if (isAdminPath(url.pathname) || isAccountPagePath(url.pathname)) {
    return applyAdminCsp(withRobotsHeader(await next(), url.pathname), {
      pageOrigin: url.origin,
      apiUrl: process.env.PUBLIC_API_URL || import.meta.env.PUBLIC_API_URL,
      dev: import.meta.env.DEV,
      collabUrl: usesHocuspocus() ? hocuspocusUrl(url) : undefined,
      // Escape hatch for rolling out to a new deployment: ADMIN_CSP_REPORT_ONLY=1.
      reportOnly: process.env.ADMIN_CSP_REPORT_ONLY === "1",
    })
  }

  return withRobotsHeader(await next(), url.pathname)
})

// X-Robots-Tag: noindex on error responses (404/500, whatever the theme's
// error layout emits) and non-public pages such as /gl-admin and /login (#137).
function withRobotsHeader(response: Response, pathname: string): Response {
  if (shouldNoindex(pathname, response.status)) {
    try {
      response.headers.set("X-Robots-Tag", "noindex, nofollow")
    } catch {
      // Immutable headers (e.g. a fetched Response passed through): leave them.
    }
  }
  return response
}
