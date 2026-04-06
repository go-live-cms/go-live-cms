/**
 * Theme Custom API Endpoints
 *
 * Catch-all route for theme-registered custom endpoints.
 * Routes requests to /api/theme/* to the appropriate theme handler.
 */

import type { APIRoute } from "astro"
import { getActiveTheme } from "../../../lib/api"
import { ThemeSettingsImpl } from "../../../lib/theme-settings"
import { ThemeAPIClientImpl } from "../../../lib/theme-api-client"
import { safeExecute } from "../../../lib/theme-api"
import type { ThemeFunctions, ThemeFunctionsContext } from "../../../lib/theme-api"

export const prerender = false

export const ALL: APIRoute = async (context) => {
  const { slug } = context.params
  const requestPath = `/${slug || ""}`

  try {
    // Get active theme
    const theme = await getActiveTheme()

    // Load theme functions
    let themeFunctions: ThemeFunctions
    try {
      const functionsModule = await import(`../../../../themes/${theme.slug}/functions.ts`)
      themeFunctions = functionsModule.default || functionsModule.themeFunctions
    } catch (error) {
      return new Response(JSON.stringify({ error: "Theme has no custom endpoints" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    }

    // Check if theme has endpoints registered
    if (!themeFunctions.endpoints || themeFunctions.endpoints.length === 0) {
      return new Response(JSON.stringify({ error: "No endpoints registered" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    }

    // Find matching endpoint
    const method = context.request.method
    const endpoint = themeFunctions.endpoints.find((ep) => ep.path === requestPath && ep.method === method)

    if (!endpoint) {
      return new Response(
        JSON.stringify({
          error: "Endpoint not found",
          available: themeFunctions.endpoints.map((ep) => ({
            path: ep.path,
            method: ep.method,
          })),
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }
      )
    }

    // Create theme context
    const authToken = context.cookies.get("auth_token")?.value || null
    const themeContext: ThemeFunctionsContext = {
      request: context.request,
      url: new URL(context.request.url),
      locals: context.locals,
      apiClient: new ThemeAPIClientImpl(authToken),
      settings: new ThemeSettingsImpl(theme.slug, authToken),
      themeSlug: theme.slug,
      user: context.locals.user || null,
    }

    // Execute endpoint handler with timeout protection
    const response = await safeExecute(() => endpoint.handler(themeContext), theme.slug, `endpoint:${requestPath}`)

    if (!response) {
      throw new Error("Endpoint handler returned no response")
    }

    return response
  } catch (error) {
    console.error("[Theme Endpoints] Error:", error)
    return new Response(
      JSON.stringify({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    )
  }
}
