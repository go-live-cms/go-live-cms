/// <reference types="astro/client" />

// No top-level import/export here: that would turn this file into a module and
// scope `App` to it, so Astro.locals would silently lose these fields. Use inline
// import() types instead.

declare namespace App {
  interface Locals {
    // This request's X-Request-ID (Caddy's), or a fresh UUID without one (#378). Log
    // lines get it from src/middleware/requestContext.ts; this copy is for anything else.
    requestId?: string

    // Phase 1: Theme assets (the active theme's `assets`, lib/themeAssets.ts)
    activeTheme?: string
    themeAssets?: import("./lib/themeAssets").ThemeAssets
    themeCssPath?: string

    // The site's published global styles for the active theme (#484, #485), which a theme's
    // base layout merges into its tokens with resolveThemeTokens (lib/themeTokens.ts).
    // From GET /themes/active's global_styles (published only); NO_GLOBAL_STYLES when none.
    // While an admin previews the design (#486), the draft instead (lib/designPreview.ts).
    globalStyles?: import("./lib/themeTokens").GlobalStyles

    // The design preview of this request (#486, lib/designPreview.ts), set once the cookie's
    // token was checked: `previewing` (the draft renders, the page gets the banner and is
    // never cached), `refused` (the API refused it: the cookie is cleared) or `off` (the API
    // couldn't answer, or another theme). `applied`: the banner or the cleared cookie was
    // added, so a rewrite's second middleware pass doesn't add it again.
    designPreview?: import("./lib/designPreview").DesignPreviewState

    // Phase 2: Theme functions
    themeFunctions?: import("./lib/theme-api").ThemeFunctions
    themeContext?: import("./lib/theme-api").ThemeFunctionsContext
    themeSetupComplete?: boolean

    // Custom theme-injected data
    themeMenu?: any
    featuredPosts?: any[]
    themeVersion?: string
    themeName?: string

    // A list route's page number when /page/N/ is rewritten to its first page (#349).
    listPageNumber?: number

    // The term a /{taxonomy}/{slug} route hands to src/pages/term.archive.astro (#348).
    termArchive?: { taxonomy: string; slug: string }

    // User authentication
    user?: any

    // Allow any other custom properties themes might inject
    [key: string]: any
  }
}
