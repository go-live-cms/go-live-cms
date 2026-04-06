/// <reference types="astro/client" />

import type { ThemeFunctions, ThemeFunctionsContext } from "./lib/theme-api"

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
    themeFunctions?: ThemeFunctions
    themeContext?: ThemeFunctionsContext
    themeSetupComplete?: boolean

    // Custom theme-injected data
    themeMenu?: any
    featuredPosts?: any[]
    themeVersion?: string
    themeName?: string

    // User authentication
    user?: any

    // Allow any other custom properties themes might inject
    [key: string]: any
  }
}
