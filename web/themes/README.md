# Go Live CMS Theme Development Guide

## Phase 2: Theme Functions API

This guide covers the WordPress-style `functions.ts` API for extending Go Live CMS themes with server-side functionality.

## Table of Contents

- [Overview](#overview)
- [Getting Started](#getting-started)
- [Theme Functions API](#theme-functions-api)
- [Theme Context](#theme-context)
- [Examples](#examples)
- [Best Practices](#best-practices)
- [Security Guidelines](#security-guidelines)
- [Troubleshooting](#troubleshooting)

## Overview

**Phase 1** (Config-only): Themes register pre-built CSS/JS assets via `theme.config.ts`

**Phase 2** (Functions): Themes can execute server-side TypeScript code via `functions.ts` to:

- Inject data into page context
- Register custom API endpoints
- Transform content with filters
- Store theme-specific settings
- Register custom post types (planned)
- Add custom blocks to the editor (planned)

## Getting Started

### Minimal Theme Structure

```
themes/
  your-theme/
    theme.config.ts    # Required - Phase 1 config
    functions.ts       # Optional - Phase 2 server-side code
    layouts/
      post/
        default.astro  # Required
      page/
        default.astro  # Required
    styles/
      theme.css        # Your pre-built CSS
    scripts/
      theme.js         # Optional JavaScript
```

### Basic functions.ts

```typescript
import { defineThemeFunctions } from "../../src/lib/theme-api"
import type { ThemeFunctionsContext } from "../../src/lib/theme-api"

export default defineThemeFunctions({
  setup: async (context) => {
    // One-time initialization
    console.log("Theme setup complete")
  },

  beforeRender: async (context) => {
    // Runs on every request
    context.locals.customData = "Hello from theme!"
  },
})
```

## Theme Functions API

### Available Hooks

#### `setup(context): Promise<void>`

Called once when the theme is initialized. Use for:

- Setting default theme options
- Registering custom post types
- One-time configuration

**Example:**

```typescript
async function setup(context: ThemeFunctionsContext): Promise<void> {
  // Set default menu if not exists
  const menu = await context.settings.get("header_menu")
  if (!menu) {
    await context.settings.set("header_menu", {
      items: [
        { label: "Home", url: "/" },
        { label: "Blog", url: "/blog" },
      ],
    })
  }

  // Register custom post type
  await context.apiClient.registerPostType({
    name: "Portfolio",
    slug: "portfolio",
    description: "Portfolio items",
    icon: "briefcase",
  })
}
```

#### `beforeRender(context): Promise<void>`

Called on every request before the page renders. Use for:

- Injecting data into `context.locals` (accessible in Astro pages)
- Fetching dynamic data (featured posts, menus, etc.)
- Per-request customization

**Example:**

```typescript
async function beforeRender(context: ThemeFunctionsContext): Promise<void> {
  // Inject menu
  const menu = await context.settings.get("header_menu")
  context.locals.themeMenu = menu

  // Inject featured posts on homepage
  if (context.url.pathname === "/") {
    const featured = await context.apiClient.getPosts({
      postType: "post",
      status: "published",
      limit: 3,
    })
    context.locals.featuredPosts = featured
  }
}
```

#### `filterContent(content, post, context): string | Promise<string>`

Transform post content before rendering. Use for:

- Shortcode parsing
- Content transformations
- Adding decorations or metadata

**Example:**

```typescript
function filterContent(content: string, post: any, context: ThemeFunctionsContext): string {
  // Parse [button] shortcode
  content = content.replace(
    /\[button text="([^"]+)" url="([^"]+)"\]/g,
    (_, text, url) => `<a href="${url}" class="btn">${text}</a>`
  )

  // Add reading time
  const wordCount = content.split(/\s+/).length
  const readingTime = Math.ceil(wordCount / 200)
  return `<div class="reading-time">${readingTime} min read</div>${content}`
}
```

#### `endpoints: ThemeEndpoint[]`

Register custom API endpoints accessible at `/api/theme/{path}`.

**Example:**

```typescript
const endpoints: ThemeEndpoint[] = [
  {
    path: "/featured",
    method: "GET",
    handler: async (context) => {
      const posts = await context.apiClient.getPosts({
        postType: "post",
        status: "published",
        limit: 5,
      })

      return new Response(JSON.stringify({ data: posts }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=300",
        },
      })
    },
  },
]
```

Access at: `GET http://localhost:4321/api/theme/featured`

## Theme Context

The `ThemeFunctionsContext` object passed to all hooks provides:

### `context.request: Request`

The incoming HTTP request.

### `context.url: URL`

Parsed URL object.

### `context.locals: Record<string, any>`

Astro locals object. Inject data here to make it available in all pages:

```typescript
context.locals.myData = { foo: "bar" }
```

Access in Astro pages:

```astro
---
const { myData } = Astro.locals;
---
<div>{myData.foo}</div>
```

### `context.apiClient: ThemeAPIClient`

Methods:

- `getPosts(params)` - Fetch posts
- `getPost(id)` - Get single post
- `registerPostType(config)` - Register custom post type
- `getTaxonomyTerms(type)` - Get taxonomy terms
- `getMedia(params)` - Get media items

**Example:**

```typescript
const posts = await context.apiClient.getPosts({
  postType: "post",
  status: "published",
  limit: 10,
  offset: 0,
})
```

### `context.settings: ThemeSettings`

Theme-specific key-value storage using the `extension_settings` table.

Methods:

- `get(key)` - Get setting value
- `set(key, value)` - Set setting value
- `delete(key)` - Delete setting
- `getAll()` - Get all theme settings

**Example:**

```typescript
// Store theme option
await context.settings.set("logo_url", "/uploads/logo.png")

// Retrieve theme option
const logoUrl = await context.settings.get("logo_url")

// Get all settings
const allSettings = await context.settings.getAll()
```

Settings are automatically namespaced by theme slug. Each theme can only access its own settings.

### `context.themeSlug: string`

Active theme slug (e.g., `'default'`).

### `context.user: any | null`

Current authenticated user (if logged in).

## Examples

### Example 1: Custom Search Endpoint

```typescript
const endpoints: ThemeEndpoint[] = [
  {
    path: "/search",
    method: "GET",
    handler: async (context) => {
      const query = new URL(context.request.url).searchParams.get("q")

      if (!query) {
        return new Response(JSON.stringify({ error: "Missing query" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
      }

      const posts = await context.apiClient.getPosts({ status: "published" })
      const results = posts.filter((p) => p.title.toLowerCase().includes(query.toLowerCase()))

      return new Response(JSON.stringify({ results, count: results.length }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    },
  },
]
```

### Example 2: Inject Featured Posts

```typescript
async function beforeRender(context: ThemeFunctionsContext): Promise<void> {
  if (context.url.pathname === "/") {
    const featured = await context.apiClient.getPosts({
      postType: "post",
      status: "published",
      limit: 3,
    })

    context.locals.featuredPosts = featured
  }
}
```

In your layout:

```astro
---
const { featuredPosts } = Astro.locals;
---
{featuredPosts && (
  <section>
    <h2>Featured Posts</h2>
    {featuredPosts.map(post => (
      <article>
        <h3>{post.title}</h3>
        <p>{post.excerpt}</p>
      </article>
    ))}
  </section>
)}
```

### Example 3: Social Share Shortcode

```typescript
function filterContent(content: string): string {
  // [share title="Check this out!"]
  return content.replace(/\[share title="([^"]+)"\]/g, (_, title) => {
    const encodedTitle = encodeURIComponent(title)
    const url = encodeURIComponent(window.location.href)
    return `
        <div class="social-share">
          <a href="https://twitter.com/intent/tweet?text=${encodedTitle}&url=${url}">
            Share on Twitter
          </a>
          <a href="https://www.facebook.com/sharer.php?u=${url}">
            Share on Facebook
          </a>
        </div>
      `
  })
}
```

## Best Practices

### 1. Use Type Safety

Import types for autocomplete and error checking:

```typescript
import { defineThemeFunctions } from '../../src/lib/theme-api';
import type { ThemeFunctionsContext, ThemeEndpoint } from '../../src/lib/theme-api';

export default defineThemeFunctions({
  // TypeScript will validate this matches ThemeFunctions interface
  setup: async (context) => { ... }
});
```

### 2. Handle Errors Gracefully

```typescript
async function beforeRender(context: ThemeFunctionsContext): Promise<void> {
  try {
    const data = await context.apiClient.getPosts({ limit: 5 })
    context.locals.recentPosts = data
  } catch (error) {
    console.error("[Theme] Failed to load recent posts:", error)
    // Set fallback data
    context.locals.recentPosts = []
  }
}
```

### 3. Cache Expensive Operations

```typescript
// Store in theme settings instead of fetching every request
async function beforeRender(context: ThemeFunctionsContext): Promise<void> {
  // Check cache first
  let cachedData = await context.settings.get("cached_popular_posts")

  if (!cachedData || cachedData.timestamp < Date.now() - 3600000) {
    // Refresh cache every hour
    const posts = await context.apiClient.getPosts({ limit: 10 })
    cachedData = {
      posts,
      timestamp: Date.now(),
    }
    await context.settings.set("cached_popular_posts", cachedData)
  }

  context.locals.popularPosts = cachedData.posts
}
```

### 4. Use Descriptive Names

```typescript
// Good
context.locals.headerNavigationMenu = menu
context.locals.homepageFeaturedPosts = featured

// Avoid
context.locals.data = menu
context.locals.posts = featured
```

### 5. Document Your Functions

```typescript
/**
 * Setup hook - initializes theme with default menu structure
 * Runs once during theme initialization
 */
async function setup(context: ThemeFunctionsContext): Promise<void> {
  // ...
}
```

## Security Guidelines

### 1. Timeout Protection

All theme functions have a 5-second timeout. Operations that take longer will be killed:

```typescript
// This will timeout after 5 seconds
async function beforeRender(context: ThemeFunctionsContext): Promise<void> {
  await someVerySlowOperation() // ❌ Bad - might timeout
}

// Better: Use settings cache or background jobs
```

### 2. Input Validation

Always validate input in custom endpoints:

```typescript
handler: async (context) => {
  const query = new URL(context.request.url).searchParams.get("q")

  if (!query || query.length > 200) {
    return new Response(JSON.stringify({ error: "Invalid query" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })
  }

  // Process validated input
}
```

### 3. Authentication

Check user authentication in endpoints that require it:

```typescript
handler: async (context) => {
  if (!context.user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })
  }

  // Proceed with authenticated request
}
```

### 4. Settings Isolation

Theme settings are automatically namespaced. You can only access your theme's settings:

```typescript
// ✅ Your theme can access this
await context.settings.get("my_option")

// ✅ Other themes cannot access your settings
// ✅ You cannot access other theme's settings
```

## Troubleshooting

### Theme Functions Not Loading

**Symptom:** `beforeRender` hook not executing

**Solutions:**

1. Check file name is exactly `functions.ts` (not `function.ts` or `Functions.ts`)
2. Ensure export matches: `export default defineThemeFunctions({ ... })`
3. Check server logs for import errors
4. Verify theme is active in database

### Timeout Errors

**Symptom:** `Theme function timed out` in logs

**Solutions:**

1. Reduce data fetch size (use pagination, limits)
2. Cache expensive operations in theme settings
3. Move long operations to custom endpoints (called async)

### Data Not Appearing in Layouts

**Symptom:** `Astro.locals.myData` is undefined

**Solutions:**

1. Verify `beforeRender` injects data: `context.locals.myData = ...`
2. Check middleware logs for errors
3. Ensure theme functions loaded successfully
4. Try restarting dev server

### Custom Endpoints 404

**Symptom:** `/api/theme/myendpoint` returns 404

**Solutions:**

1. Verify endpoint path matches: `{ path: '/myendpoint', ... }`
2. Check endpoint is in `endpoints` array and exported
3. Confirm theme is active
4. Check for typos in URL

### TypeScript Errors

**Symptom:** Type errors in `functions.ts`

**Solutions:**

1. Import types: `import type { ThemeFunctionsContext } from '../../src/lib/theme-api'`
2. Use `defineThemeFunctions()` helper for type checking
3. Check VS Code is using workspace TypeScript version

## Additional Resources

- **Example Theme:** See `/web/themes/example/` for a complete reference implementation
- **API Reference:** `/web/src/lib/theme-api.ts` contains all type definitions
- **System Themes:** Check `/web/themes/default/` and `/web/themes/test/` for simpler examples

## Support

For issues or questions:

1. Check example theme implementation
2. Review error logs in terminal
3. Open issue on GitHub with reproduction steps

---

**Happy Theme Development! 🎨**
