import { defineMiddleware } from "astro:middleware"
import fs from "node:fs"
import path from "node:path"
import { getActiveTheme } from "../lib/api"

export const onRequest = defineMiddleware(async (context, next) => {
  const url = new URL(context.request.url)

  // Inject active theme metadata into locals for use in layouts
  if (!context.locals.activeTheme) {
    try {
      const theme = await getActiveTheme()
      context.locals.activeTheme = theme.slug
      context.locals.themeCssPath = `/themes/${theme.slug}/styles/theme.css`
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
