/// <reference types="astro/client" />

// No top-level import/export here: that would turn this file into a module and
// scope `App` to it, so Astro.locals would silently lose these fields. Use inline
// import() types instead.

declare namespace App {
  interface Locals {
    // Phase 1: Theme assets
    activeTheme?: string
    themeAssets?: {
      styles?: Array<{ src: string; media?: string }>
      scripts?: Array<{ src: string; defer?: boolean; async?: boolean; type?: string }>
    }
    themeCssPath?: string

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

    // User authentication
    user?: any

    // Allow any other custom properties themes might inject
    [key: string]: any
  }
}
