/**
 * Theme API - Type definitions and utilities for theme functions.ts
 *
 * This module provides the API surface that themes can use to extend
 * the CMS functionality in WordPress-style patterns.
 */

import type { APIContext } from "astro"

/**
 * API client for interacting with Go Live CMS backend
 */
export interface ThemeAPIClient {
  /**
   * Fetch posts with optional filters
   */
  getPosts: (params?: { postType?: string; status?: string; limit?: number; offset?: number }) => Promise<any[]>

  /**
   * Get a single post by ID
   */
  getPost: (id: number) => Promise<any>

  /**
   * Register a custom post type
   * Calls POST /api/v1/post-types with the configuration
   */
  registerPostType: (config: {
    name: string
    slug: string
    description?: string
    icon?: string
    supports?: string[]
  }) => Promise<void>

  /**
   * Get taxonomy terms
   */
  getTaxonomyTerms: (taxonomyType: string) => Promise<any[]>

  /**
   * Get media items
   */
  getMedia: (params?: { limit?: number; offset?: number }) => Promise<any[]>
}

/**
 * Theme settings storage interface
 * Automatically namespaced by theme slug using extension_settings table
 */
export interface ThemeSettings {
  /**
   * Get a theme setting value
   */
  get: (key: string) => Promise<any>

  /**
   * Set a theme setting value
   */
  set: (key: string, value: any) => Promise<void>

  /**
   * Delete a theme setting
   */
  delete: (key: string) => Promise<void>

  /**
   * Get all theme settings
   */
  getAll: () => Promise<Record<string, any>>
}

/**
 * Context object passed to theme functions
 * Provides access to request data, API, and utilities
 */
export interface ThemeFunctionsContext {
  /**
   * The incoming request object
   */
  request: Request

  /**
   * Parsed URL from the request
   */
  url: URL

  /**
   * Astro locals object - can be modified to inject data into pages
   */
  locals: Record<string, any>

  /**
   * API client for backend operations
   */
  apiClient: ThemeAPIClient

  /**
   * Theme-specific settings storage
   */
  settings: ThemeSettings

  /**
   * Active theme slug
   */
  themeSlug: string

  /**
   * Current user (if authenticated)
   */
  user?: any
}

/**
 * Custom API endpoint definition
 */
export interface ThemeEndpoint {
  /**
   * URL path relative to /api/theme/
   * Example: "search" → /api/theme/search
   */
  path: string

  /**
   * HTTP method
   */
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH"

  /**
   * Request handler
   */
  handler: (context: ThemeFunctionsContext) => Promise<Response>
}

/**
 * Custom block definition for Tiptap editor
 */
export interface ThemeBlock {
  /**
   * Unique block identifier
   */
  name: string

  /**
   * Display label
   */
  label: string

  /**
   * Block icon (emoji or icon name)
   */
  icon: string

  /**
   * Block category
   */
  category?: string

  /**
   * Block component path (relative to theme)
   */
  component: string

  /**
   * Default attributes
   */
  attributes?: Record<string, any>
}

/**
 * Main theme functions interface
 * Export an object matching this interface from functions.ts
 */
export interface ThemeFunctions {
  /**
   * Setup function - called once when theme is initialized
   * Use this for one-time registration (post types, settings, etc.)
   */
  setup?: (context: ThemeFunctionsContext) => Promise<void>

  /**
   * Before render hook - called on every request before page renders
   * Use this to inject data into Astro.locals
   */
  beforeRender?: (context: ThemeFunctionsContext) => Promise<void>

  /**
   * Content filter - transform post content before rendering
   */
  filterContent?: (content: string, post: any, context: ThemeFunctionsContext) => Promise<string> | string

  /**
   * Custom API endpoints to register
   */
  endpoints?: ThemeEndpoint[]

  /**
   * Custom blocks for Tiptap editor
   */
  blocks?: ThemeBlock[]
}

/**
 * Helper function to create a theme functions object with type safety
 */
export function defineThemeFunctions(functions: ThemeFunctions): ThemeFunctions {
  return functions
}

/**
 * Timeout wrapper for theme function execution
 * Prevents theme code from blocking requests indefinitely
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number = 5000,
  errorMessage: string = "Theme function timed out"
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(errorMessage)), timeoutMs)),
  ])
}

/**
 * Safe execution wrapper for theme functions
 * Catches errors and logs them without crashing the request
 */
export async function safeExecute<T>(
  fn: () => Promise<T>,
  themeSlug: string,
  functionName: string,
  fallback?: T
): Promise<T | undefined> {
  try {
    return await withTimeout(fn(), 5000, `${functionName} timed out`)
  } catch (error) {
    console.error(`[Theme: ${themeSlug}] Error in ${functionName}:`, error)
    return fallback
  }
}
