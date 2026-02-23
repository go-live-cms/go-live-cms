/**
 * Example Theme Functions
 *
 * Demonstrates Phase 2 theme API capabilities:
 * - Setup hook for one-time initialization
 * - BeforeRender hook for request-time data injection
 * - Content filtering with shortcode support
 * - Custom API endpoints
 * - Theme settings storage
 *
 * This is the WordPress functions.php equivalent for Go Live CMS themes.
 */

import { defineThemeFunctions } from "../../src/lib/theme-api"
import type { ThemeFunctionsContext, ThemeEndpoint } from "../../src/lib/theme-api"

/**
 * Setup function - called once when theme loads
 * Use for:
 * - Registering custom post types
 * - Setting up default theme options
 * - One-time initialization
 */
async function setup(context: ThemeFunctionsContext): Promise<void> {
  console.log(`[Example Theme] Running setup for ${context.themeSlug}`)

  // Example: Set default theme option if not exists
  const menuSettings = await context.settings.get("header_menu")
  if (!menuSettings) {
    await context.settings.set("header_menu", {
      items: [
        { label: "Home", url: "/" },
        { label: "Blog", url: "/blog" },
        { label: "About", url: "/about" },
      ],
    })
    console.log("[Example Theme] Initialized default menu")
  }

  // Register custom post type declared in theme.config.ts
  // The Go backend scanner handles this declaratively, but setup() can also
  // call registerPostType for dynamic post types not in the config.
  try {
    await context.apiClient.registerPostType({
      name: "product",
      slug: "product",
      description: "Product listings for the store",
      icon: "shopping-bag",
      supports: ["title", "content", "description", "featured_image"],
    })
    console.log("[Example Theme] Registered product post type")
  } catch (error) {
    // Safe to ignore — upsert semantics mean this is idempotent
    console.warn("[Example Theme] Post type registration note:", error)
  }
}

/**
 * Before render hook - called on every request
 * Use for:
 * - Injecting data into page context (Astro.locals)
 * - Fetching dynamic data (featured posts, menus, etc.)
 * - Per-request customization
 */
async function beforeRender(context: ThemeFunctionsContext): Promise<void> {
  // Example: Inject custom menu into all pages
  try {
    const menuSettings = await context.settings.get("header_menu")
    context.locals.themeMenu = menuSettings
  } catch (error) {
    console.error("[Example Theme] Error loading menu:", error)
  }

  // Example: Inject featured posts on homepage
  if (context.url.pathname === "/") {
    try {
      const featuredPosts = await context.apiClient.getPosts({
        postType: "post",
        status: "published",
        limit: 3,
      })
      context.locals.featuredPosts = featuredPosts
      console.log("[Example Theme] Injected featured posts")
    } catch (error) {
      console.error("[Example Theme] Error loading featured posts:", error)
    }
  }

  // Example: Add custom data to all pages
  context.locals.themeVersion = "1.0.0"
  context.locals.themeName = "Example Theme"
}

/**
 * Content filter - transform post content before rendering
 * Use for:
 * - Shortcode parsing
 * - Content transformations
 * - Adding wrappers or decorations
 */
function filterContent(content: string, post: any, context: ThemeFunctionsContext): string {
  if (!content) return content

  // Example: Parse shortcodes
  // [button text="Click Me" url="/contact"]
  content = content.replace(/\[button\s+text="([^"]+)"\s+url="([^"]+)"\]/g, (_, text, url) => {
    return `<a href="${url}" class="theme-button">${text}</a>`
  })

  // Example: Parse [gallery] shortcode
  // [gallery]
  content = content.replace(/\[gallery\]/g, () => {
    return `<div class="theme-gallery">Gallery placeholder</div>`
  })

  // Example: Add reading time
  const wordCount = content.split(/\s+/).length
  const readingTime = Math.ceil(wordCount / 200) // 200 words per minute

  // Inject reading time at the start (only for posts, not pages)
  if (post.post_type === "post") {
    content = `<div class="reading-time">${readingTime} min read</div>\n${content}`
  }

  return content
}

/**
 * Custom API endpoints
 * These are accessible at /api/theme/{path}
 */
const endpoints: ThemeEndpoint[] = [
  {
    path: "/featured",
    method: "GET",
    handler: async (context) => {
      try {
        // Fetch featured posts
        const posts = await context.apiClient.getPosts({
          postType: "post",
          status: "published",
          limit: 5,
        })

        // Filter to only include posts with featured_image
        const featuredPosts = posts.filter((p) => p.featured_image_id)

        return new Response(
          JSON.stringify({
            success: true,
            data: featuredPosts,
            count: featuredPosts.length,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "public, max-age=300", // Cache for 5 minutes
            },
          }
        )
      } catch (error) {
        return new Response(
          JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }
        )
      }
    },
  },
  {
    path: "/search",
    method: "GET",
    handler: async (context) => {
      const searchParams = new URL(context.request.url).searchParams
      const query = searchParams.get("q")

      if (!query) {
        return new Response(JSON.stringify({ success: false, error: "Missing query parameter" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
      }

      try {
        // Basic search implementation - in production, use proper search API
        const allPosts = await context.apiClient.getPosts({
          status: "published",
          limit: 100,
        })

        const results = allPosts.filter((post) => {
          const searchText = `${post.title} ${post.content || ""} ${post.excerpt || ""}`.toLowerCase()
          return searchText.includes(query.toLowerCase())
        })

        return new Response(
          JSON.stringify({
            success: true,
            query: query,
            results: results,
            count: results.length,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "public, max-age=60",
            },
          }
        )
      } catch (error) {
        return new Response(
          JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : "Search failed",
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }
        )
      }
    },
  },
]

// Export theme functions using type-safe helper
export default defineThemeFunctions({
  setup,
  beforeRender,
  filterContent,
  endpoints,
})
