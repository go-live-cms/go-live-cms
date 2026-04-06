# Go Live CMS Theme Development Guide

A comprehensive guide to building themes for Go Live CMS. Themes control the entire frontend presentation — layouts, styles, scripts, custom blocks, and server-side logic.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Quick Start](#quick-start)
- [Theme Structure](#theme-structure)
- [Theme Configuration (theme.config.ts)](#theme-configuration-themeconfigts)
- [Layouts](#layouts)
  - [Layout Variants](#layout-variants)
  - [Base Layouts](#base-layouts)
  - [Rendering Content](#rendering-content)
  - [Accessing Theme Data in Layouts](#accessing-theme-data-in-layouts)
- [Assets (CSS & JavaScript)](#assets-css--javascript)
- [Theme Functions (functions.ts)](#theme-functions-functionsts)
  - [setup()](#setup)
  - [beforeRender()](#beforerender)
  - [filterContent()](#filtercontent)
  - [Custom Endpoints](#custom-endpoints)
- [Theme Context API](#theme-context-api)
- [Custom Blocks](#custom-blocks)
  - [Block Architecture](#block-architecture)
  - [Creating a Custom Block](#creating-a-custom-block)
  - [1. SSR Component (BlockName.tsx)](#1-ssr-component-blocknametsx)
  - [2. Tiptap Extension (BlockExtension.ts)](#2-tiptap-extension-blockextensiontsx)
  - [3. Editor Node View (BlockNodeView.tsx)](#3-editor-node-view-blocknodeviewtsx)
  - [4. Block Index (index.ts)](#4-block-index-indexts)
  - [5. Register in theme.config.ts](#5-register-in-themeconfigts)
  - [Built-in Block Types](#built-in-block-types)
- [Design Tokens & Dark Mode](#design-tokens--dark-mode)
- [How Theme Loading Works](#how-theme-loading-works)
- [Best Practices](#best-practices)
- [Security Guidelines](#security-guidelines)
- [Troubleshooting](#troubleshooting)

---

## Architecture Overview

Go Live CMS themes follow a WordPress-inspired architecture adapted for modern TypeScript:

| WordPress Concept                  | Go Live CMS Equivalent                |
| ---------------------------------- | ------------------------------------- |
| `style.css` / `functions.php`      | `theme.config.ts` / `functions.ts`    |
| `wp_enqueue_style()`               | `assets.styles[]` in config           |
| `wp_enqueue_script()`              | `assets.scripts[]` in config          |
| Template hierarchy                 | `layouts/{post_type}/{variant}.astro` |
| `header.php` / `footer.php`        | `base.astro` (optional shared layout) |
| `register_block_type()`            | `blocks[]` in config + block module   |
| `add_action('init')`               | `setup()` hook                        |
| `add_action('template_redirect')`  | `beforeRender()` hook                 |
| `apply_filters('the_content')`     | `filterContent()` hook                |
| `register_rest_route()`            | `endpoints[]` array                   |
| `get_option()` / `update_option()` | `context.settings.get()` / `.set()`   |

**Rendering pipeline:**

1. **Go backend** scans `web/themes/*/`, syncs discovered themes to the database
2. **Astro middleware** loads the active theme's `theme.config.ts` and `functions.ts` on every request
3. **Route handler** resolves the correct layout file (`themes/{slug}/layouts/{postType}/{variant}.astro`)
4. **Layout** renders using `<BlockRenderer>` to turn the post's `published_blocks` (BlockDocV1) into HTML
5. **Admin editor** (React + TipTap) loads custom block extensions from the theme for editing

---

## Quick Start

### 1. Create your theme folder

```
web/themes/my-theme/
```

### 2. Add the required files

```
web/themes/my-theme/
  theme.config.ts          # Required — theme metadata + assets
  layouts/
    post/default.astro     # Required — default post layout
    page/default.astro     # Required — default page layout
```

### 3. Minimal `theme.config.ts`

```typescript
export const themeConfig = {
  name: "My Theme",
  description: "A custom theme for Go Live CMS",
  version: "1.0.0",
  author: "Your Name",
  layouts: {
    post: { default: "default", variants: ["default"] },
    page: { default: "default", variants: ["default"] },
  },
  assets: {
    styles: [{ src: "/themes/my-theme/styles/theme.css" }],
  },
}

export default themeConfig
```

### 4. Minimal layout

```astro
---
// layouts/post/default.astro
import BlockRenderer from '@/components/BlockRenderer'

interface Props {
  post: any
  title: string
  description: string
}

const { post, title, description } = Astro.props
---

<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{title}</title>
    {Astro.locals.themeAssets?.styles?.map((style: any) => (
      <link rel="stylesheet" href={style.src} media={style.media || 'all'} />
    ))}
  </head>
  <body>
    <article>
      <h1>{post.title}</h1>
      <div class="content">
        {post.published_blocks ? (
          <BlockRenderer doc={post.published_blocks} client:load />
        ) : (
          <p>No content available</p>
        )}
      </div>
    </article>

    {Astro.locals.themeAssets?.scripts?.map((script: any) => (
      <script src={script.src} defer={script.defer} async={script.async}></script>
    ))}
  </body>
</html>
```

### 5. Activate

Set your theme as active via the admin panel or the API (`PUT /themes/:id/activate`). The Go backend auto-discovers themes from the `web/themes/` directory.

---

## Theme Structure

### Minimal Theme

```
themes/my-theme/
  theme.config.ts              # Required — metadata, assets, blocks
  layouts/
    post/default.astro         # Required — default post layout
    page/default.astro         # Required — default page layout
```

### Full-Featured Theme

```
themes/my-theme/
  theme.config.ts              # Theme configuration
  functions.ts                 # Server-side hooks & endpoints
  thumbnail.jpg                # Theme preview image (shown in admin)
  README.md                    # Theme documentation

  layouts/
    base.astro                 # Shared HTML wrapper (optional)
    post/
      default.astro            # Default post layout
      sidebar.astro            # Post with sidebar variant
      wide.astro               # Full-width variant
    page/
      default.astro            # Default page layout
      fullwidth.astro          # Full-width page variant

  blocks/                      # Custom blocks (optional)
    Alert/
      AlertBlock.tsx           # SSR render component
      AlertExtension.ts        # TipTap editor extension
      AlertNodeView.tsx        # Editor in-place preview
      index.ts                 # Registration exports

  styles/
    theme.css                  # Compiled CSS (any build tool)
    theme.scss                 # Source SCSS (optional)
    _variables.scss            # Design tokens (optional)

  scripts/
    theme.js                   # Client-side JavaScript
```

The Go backend validates that every theme has `theme.config.ts` and the required default layouts for each post type.

---

## Theme Configuration (`theme.config.ts`)

This is the only required file beyond layouts. It defines your theme's metadata, assets, layout variants, and custom blocks.

### Simple Configuration

Used by the example theme — straightforward, covers most use cases:

```typescript
export interface ThemeConfig {
  name: string
  description: string
  version: string
  author: string
  thumbnail?: string
  screenshots?: string[]

  layouts: {
    post: { default: string; variants: string[] }
    page: { default: string; variants: string[] }
  }

  assets: {
    styles: Array<{ src: string; media?: string }>
    scripts?: Array<{ src: string; defer?: boolean; async?: boolean; type?: string }>
  }

  // Custom blocks registered by this theme
  blocks?: Array<{
    type: string // Block type identifier (e.g. "alert")
    modulePath: string // Absolute path from web root (e.g. "/themes/my-theme/blocks/Alert/index.ts")
  }>
}
```

**Example:**

```typescript
export const themeConfig: ThemeConfig = {
  name: "My Theme",
  description: "A beautiful blog theme",
  version: "1.0.0",
  author: "Your Name",
  thumbnail: "/themes/my-theme/thumbnail.jpg",

  layouts: {
    post: { default: "default", variants: ["default", "sidebar", "wide"] },
    page: { default: "default", variants: ["default", "fullwidth"] },
  },

  assets: {
    styles: [{ src: "/themes/my-theme/styles/theme.css", media: "all" }],
    scripts: [{ src: "/themes/my-theme/scripts/theme.js", defer: true }],
  },

  blocks: [
    { type: "alert", modulePath: "/themes/my-theme/blocks/Alert/index.ts" },
    { type: "callout", modulePath: "/themes/my-theme/blocks/Callout/index.ts" },
  ],
}

export default themeConfig
```

### Full Configuration

Used by the default and test themes — includes design tokens, dark mode, typography, and more:

```typescript
export const themeConfig: ThemeConfig = {
  name: "Default Theme",
  description: "The default theme for Go Live CMS",
  version: "1.0.0",
  author: "Go Live CMS",
  license: "MIT",
  parent: undefined, // Set to parent theme slug for child themes

  assets: {
    styles: [{ src: "/themes/default/styles/theme.css", media: "all" }],
  },

  supports: {
    postTypes: ["post", "page"],
    customBlocks: true,
    darkMode: true,
    childThemes: true,
  },

  colors: {
    light: {
      primary: "59 130 246", // RGB values for CSS custom properties
      secondary: "100 116 139",
      background: "255 255 255",
      surface: "248 250 252",
      text: "15 23 42",
      textMuted: "100 116 139",
      border: "226 232 240",
      accent: "168 85 247",
    },
    dark: {
      primary: "96 165 250",
      secondary: "148 163 184",
      background: "15 23 42",
      surface: "30 41 59",
      text: "241 245 249",
      textMuted: "148 163 184",
      border: "51 65 85",
      accent: "192 132 252",
    },
  },

  typography: {
    fontFamily: {
      base: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      heading: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      mono: '"Courier New", Courier, monospace',
    },
    fontSize: {
      xs: "0.75rem",
      sm: "0.875rem",
      base: "1rem",
      lg: "1.125rem",
      xl: "1.25rem",
      "2xl": "1.5rem",
      "3xl": "1.875rem",
      "4xl": "2.25rem",
    },
  },

  layout: {
    container: "1200px",
    gutter: "2rem",
  },

  layouts: {
    post: {
      default: { file: "layouts/post/default.astro", label: "Default Post", description: "Clean, centered layout" },
      sidebar: { file: "layouts/post/sidebar.astro", label: "Post with Sidebar", description: "Two-column layout" },
      wide: { file: "layouts/post/wide.astro", label: "Wide Layout", description: "Full-width content" },
    },
    page: {
      default: { file: "layouts/page/default.astro", label: "Default Page", description: "Standard page layout" },
      fullwidth: { file: "layouts/page/fullwidth.astro", label: "Full Width", description: "Edge-to-edge layout" },
    },
  },

  darkMode: {
    strategy: "class", // "class" or "media"
    attribute: "data-theme", // HTML attribute to set
    defaultMode: "system", // "light", "dark", or "system"
    storageKey: "gl-theme-preference",
  },
}

export default themeConfig
```

---

## Layouts

Layouts are Astro components (`.astro` files) that control how posts and pages are rendered. They live in `layouts/{post_type}/{variant}.astro`.

### Layout Props

Every layout receives these props from the route handler:

```typescript
interface Props {
  post: Post // The full post object
  title: string // Post title (for <title> tag)
  description: string // Post description (for meta tag)
}
```

The `Post` object includes:

```typescript
interface Post {
  id: number
  title: string
  description: string
  published_blocks?: BlockDocV1 // The block document — this is your content
  featured_image?: string
  user_id: number
  username: string
  url: string
  slug?: string
  post_type: string // "post", "page", etc.
  post_status: string
  created_at: string
  changed_at: string
}
```

> **Important:** Content is stored as `published_blocks` (a structured block document), **not** as an HTML string. Always use `<BlockRenderer>` to render it.

### Layout Variants

Each post type can have multiple layout variants. Users select the variant per-post in the admin editor. The route handler resolves the active variant from the database and loads the correct `.astro` file.

```
layouts/
  post/
    default.astro      # "default" variant
    sidebar.astro      # "sidebar" variant
    wide.astro         # "wide" variant
  page/
    default.astro      # "default" variant
    fullwidth.astro    # "fullwidth" variant
```

Register them in `theme.config.ts`:

```typescript
layouts: {
  post: { default: "default", variants: ["default", "sidebar", "wide"] },
  page: { default: "default", variants: ["default", "fullwidth"] },
}
```

If a requested variant doesn't exist, the system falls back to `default`. If the entire theme layout fails, it falls back to the `default` theme's layout.

### Base Layouts

For themes with shared HTML structure (header, footer, meta tags), create a `base.astro` wrapper:

```astro
---
// layouts/base.astro
import themeConfig from '../theme.config'

interface Props {
  title: string
  description: string
}

const { title, description } = Astro.props
const themeAssets = Astro.locals.themeAssets || {}
---

<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width" />
    <meta name="description" content={description} />
    <title>{title}</title>

    <!-- Theme-registered stylesheets -->
    {themeAssets.styles?.map((style: any) => (
      <link rel="stylesheet" href={style.src} media={style.media || 'all'} />
    ))}

    <slot name="head" />
  </head>
  <body>
    <slot />

    <!-- Theme-registered scripts -->
    {themeAssets.scripts?.map((script: any) => (
      <script src={script.src} defer={script.defer} async={script.async}></script>
    ))}
  </body>
</html>
```

Then use it in your post/page layouts:

```astro
---
// layouts/post/default.astro
import BaseLayout from '../base.astro'
import BlockRenderer from '@/components/BlockRenderer'
import type { Post } from '@gl-admin/lib/api/types'

interface Props {
  post: Post
  title: string
  description: string
}

const { post, title, description } = Astro.props
---

<BaseLayout title={title} description={description}>
  <main>
    <article>
      <h1>{post.title}</h1>
      <div class="content">
        {post.published_blocks && (
          <BlockRenderer doc={post.published_blocks} client:load />
        )}
      </div>
    </article>
  </main>
</BaseLayout>
```

### Rendering Content

Content is stored as a `BlockDocV1` — a structured document of typed blocks (paragraphs, headings, images, custom blocks, etc.). Use the `BlockRenderer` component to render it:

```astro
---
import BlockRenderer from '@/components/BlockRenderer'
---

{post.published_blocks ? (
  <BlockRenderer doc={post.published_blocks} client:load />
) : (
  <p>No content available</p>
)}
```

**Key points:**

- Always use `client:load` — BlockRenderer is a React component that needs hydration
- `BlockRenderer` looks up each block's render component from the block registry
- Custom theme blocks are automatically registered when the theme loads
- The output is wrapped in `<div class="block-content">...</div>`

**Never** try to render `post.content` — that field does not exist. Always use `post.published_blocks` with `BlockRenderer`.

### Accessing Theme Data in Layouts

The middleware injects theme assets into `Astro.locals`. If your theme has a `functions.ts` with a `beforeRender()` hook, any data you inject into `context.locals` is also available:

```astro
---
// Available from middleware (always present):
const themeAssets = Astro.locals.themeAssets  // { styles: [...], scripts: [...] }

// Available from functions.ts beforeRender() (if you inject them):
const themeMenu = Astro.locals.themeMenu
const featuredPosts = Astro.locals.featuredPosts
const themeName = Astro.locals.themeName
---
```

---

## Assets (CSS & JavaScript)

Themes register pre-built CSS and JS files in `theme.config.ts`. The middleware injects them into `Astro.locals.themeAssets`, and your layouts render them in `<head>` and before `</body>`.

```typescript
assets: {
  styles: [
    { src: "/themes/my-theme/styles/theme.css", media: "all" },
    { src: "/themes/my-theme/styles/print.css", media: "print" },
  ],
  scripts: [
    { src: "/themes/my-theme/scripts/theme.js", defer: true },
    { src: "/themes/my-theme/scripts/analytics.js", async: true },
  ],
}
```

**Asset options:**

| Property | Type      | Description                                                   |
| -------- | --------- | ------------------------------------------------------------- |
| `src`    | `string`  | Path from web root (e.g. `/themes/my-theme/styles/theme.css`) |
| `media`  | `string`  | CSS media query (default: `"all"`)                            |
| `defer`  | `boolean` | Defer script loading                                          |
| `async`  | `boolean` | Async script loading                                          |
| `type`   | `string`  | Script type (e.g. `"module"`)                                 |

**Build your CSS however you want** — SCSS, Tailwind, PostCSS, plain CSS. The theme system only cares about the compiled output file. The middleware serves files from `web/themes/` with proper MIME types and caching headers.

**In your layout**, render them like this:

```astro
<!-- In <head> -->
{Astro.locals.themeAssets?.styles?.map((style: any) => (
  <link rel="stylesheet" href={style.src} media={style.media || 'all'} />
))}

<!-- Before </body> -->
{Astro.locals.themeAssets?.scripts?.map((script: any) => (
  <script src={script.src} defer={script.defer} async={script.async} type={script.type}></script>
))}
```

---

## Theme Functions (`functions.ts`)

Optional server-side TypeScript that runs on the Astro server. This is the equivalent of WordPress's `functions.php`.

```typescript
import { defineThemeFunctions } from "../../src/lib/theme-api"
import type { ThemeFunctionsContext, ThemeEndpoint } from "../../src/lib/theme-api"

export default defineThemeFunctions({
  setup,
  beforeRender,
  filterContent,
  endpoints,
})
```

### `setup()`

Called **once** when the theme is first loaded. Use for one-time initialization.

```typescript
async function setup(context: ThemeFunctionsContext): Promise<void> {
  // Set default settings if they don't exist yet
  const menu = await context.settings.get("header_menu")
  if (!menu) {
    await context.settings.set("header_menu", {
      items: [
        { label: "Home", url: "/" },
        { label: "Blog", url: "/blog" },
        { label: "About", url: "/about" },
      ],
    })
  }
}
```

### `beforeRender()`

Called on **every request** before the page renders. Inject data into `context.locals` to make it available in all Astro layouts.

```typescript
async function beforeRender(context: ThemeFunctionsContext): Promise<void> {
  // Load menu for all pages
  try {
    const menu = await context.settings.get("header_menu")
    context.locals.themeMenu = menu
  } catch (error) {
    console.error("[Theme] Error loading menu:", error)
  }

  // Inject featured posts only on homepage
  if (context.url.pathname === "/") {
    const featured = await context.apiClient.getPosts({
      postType: "post",
      status: "published",
      limit: 3,
    })
    context.locals.featuredPosts = featured
  }

  // Add theme metadata
  context.locals.themeName = "My Theme"
  context.locals.themeVersion = "1.0.0"
}
```

### `filterContent()`

Transform rendered content before it's sent to the browser. Useful for shortcode parsing.

```typescript
function filterContent(content: string, post: any, context: ThemeFunctionsContext): string {
  if (!content) return content

  // Parse [button text="Click Me" url="/contact"] shortcode
  content = content.replace(
    /\[button\s+text="([^"]+)"\s+url="([^"]+)"\]/g,
    (_, text, url) => `<a href="${url}" class="theme-button">${text}</a>`
  )

  // Add reading time for posts
  if (post.post_type === "post") {
    const wordCount = content.split(/\s+/).length
    const readingTime = Math.ceil(wordCount / 200)
    content = `<div class="reading-time">${readingTime} min read</div>\n${content}`
  }

  return content
}
```

### Custom Endpoints

Register REST API endpoints accessible at `/api/theme/{path}`:

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

      return new Response(JSON.stringify({ success: true, data: posts }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=300",
        },
      })
    },
  },
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

Access at: `GET http://localhost:4321/api/theme/featured`

---

## Theme Context API

The `ThemeFunctionsContext` object is passed to all hooks and endpoint handlers:

### `context.request: Request`

The incoming HTTP request object.

### `context.url: URL`

Parsed URL — use `context.url.pathname`, `context.url.searchParams`, etc.

### `context.locals: Record<string, any>`

Astro locals object. Data injected here is available in all layout files via `Astro.locals`:

```typescript
// In functions.ts:
context.locals.myData = { foo: "bar" }
```

```astro
<!-- In layout: -->
{Astro.locals.myData.foo}
```

### `context.apiClient: ThemeAPIClient`

Backend API client with these methods:

| Method                     | Description                                                    |
| -------------------------- | -------------------------------------------------------------- |
| `getPosts(params?)`        | Fetch posts (supports `postType`, `status`, `limit`, `offset`) |
| `getPost(id)`              | Get a single post by ID                                        |
| `registerPostType(config)` | Register a custom post type                                    |
| `getTaxonomyTerms(type)`   | Get taxonomy terms                                             |
| `getMedia(params?)`        | Get media items                                                |

### `context.settings: ThemeSettings`

Theme-specific key-value storage, automatically namespaced by theme slug. Each theme can only access its own settings.

| Method            | Description                                   |
| ----------------- | --------------------------------------------- |
| `get(key)`        | Get a setting value                           |
| `set(key, value)` | Store a setting (any JSON-serializable value) |
| `delete(key)`     | Remove a setting                              |
| `getAll()`        | Get all settings as `Record<string, any>`     |

```typescript
await context.settings.set("site_logo", "/uploads/logo.png")
const logo = await context.settings.get("site_logo")
const all = await context.settings.getAll()
await context.settings.delete("old_setting")
```

### `context.themeSlug: string`

The active theme's slug (directory name), e.g. `"default"`, `"example"`.

### `context.user: any | null`

The currently authenticated user, or `null` if not logged in.

---

## Custom Blocks

Themes can define custom block types that appear in the admin editor's slash command menu and render on the frontend.

### Block Architecture

Each custom block has three parts that work together:

| File                | Purpose                  | Where it runs                                           |
| ------------------- | ------------------------ | ------------------------------------------------------- |
| `BlockName.tsx`     | SSR render component     | Frontend (Astro/React) — renders the block for visitors |
| `BlockExtension.ts` | TipTap Node definition   | Admin editor — defines the block in ProseMirror schema  |
| `BlockNodeView.tsx` | Editor preview component | Admin editor — how the block looks while editing        |
| `index.ts`          | Registration exports     | Both — ties everything together                         |

**Registration flow:**

1. `theme.config.ts` lists blocks in the `blocks[]` array
2. On the **frontend**, the SSR block registry dynamically imports the block module and registers the `component` from the `BlockConfig` export
3. In the **admin editor**, the `ThemeContext` dynamically imports the block module and registers:
   - The TipTap extension (so the editor schema knows about the block)
   - The editor config (so the block appears in the slash command menu)

### Creating a Custom Block

Here's a complete example of a custom Alert block.

### 1. SSR Component (`AlertBlock.tsx`)

This renders the block on the frontend for visitors:

```tsx
import React from "react"
import type { BlockComponentProps } from "../../../../src/components/blocks/types"

const AlertBlock: React.FC<BlockComponentProps> = ({ block, getBlockContent }) => {
  const attrs = block.attrs as { variant?: string; message?: string; text?: string; pm?: any }
  const variant = attrs.variant || "info"

  // getBlockContent() renders ProseMirror content (preserves bold, italic, links, etc.)
  // Falls back to plain text attributes if no PM content exists
  const content = getBlockContent(block) || attrs.text || attrs.message || "Alert message"

  const styles: Record<string, { bg: string; border: string; text: string; icon: string }> = {
    info: { bg: "#dbeafe", border: "#3b82f6", text: "#1e40af", icon: "ℹ️" },
    success: { bg: "#d1fae5", border: "#10b981", text: "#065f46", icon: "✓" },
    warning: { bg: "#fef3c7", border: "#f59e0b", text: "#92400e", icon: "⚠️" },
    error: { bg: "#fee2e2", border: "#ef4444", text: "#991b1b", icon: "✕" },
  }

  const style = styles[variant] || styles.info

  return (
    <div
      key={block.id}
      style={{
        padding: "1rem 1.25rem",
        backgroundColor: style.bg,
        border: `2px solid ${style.border}`,
        borderRadius: "0.5rem",
        color: style.text,
        marginBottom: "1rem",
        display: "flex",
        alignItems: "flex-start",
        gap: "0.75rem",
      }}
    >
      <span style={{ fontSize: "1.25rem", flexShrink: 0 }}>{style.icon}</span>
      <div style={{ flex: 1 }}>
        <strong style={{ display: "block", marginBottom: "0.25rem", textTransform: "capitalize" }}>{variant}</strong>
        <div>{content}</div>
      </div>
    </div>
  )
}

export default AlertBlock
```

The `BlockComponentProps` interface gives every block:

| Prop              | Type                                | Description                                     |
| ----------------- | ----------------------------------- | ----------------------------------------------- |
| `block`           | `Block`                             | The block data (id, type, attrs, children)      |
| `doc`             | `BlockDocV1`                        | Full document context                           |
| `renderContent`   | `(content: PMNode[]) => ReactNode`  | Render ProseMirror inline content with marks    |
| `getBlockContent` | `(block: Block) => ReactNode`       | Get block content from PM data or fallback text |
| `renderBlock`     | `(blockId: string) => ReactElement` | Render a child block by ID (for nested blocks)  |

### 2. TipTap Extension (`AlertExtension.ts`)

This tells the editor's ProseMirror schema about your block:

```typescript
import { Node } from "@tiptap/core"
import { ReactNodeViewRenderer } from "@tiptap/react"
import { AlertNodeView } from "./AlertNodeView.tsx"

export const AlertExtension = Node.create({
  name: "alert", // Must match the block type

  group: "block", // Makes it a block-level node

  content: "text*", // What content it can contain (text with marks)

  addAttributes() {
    return {
      variant: {
        default: "info",
        parseHTML: (el) => el.getAttribute("data-variant"),
        renderHTML: (attrs) => ({ "data-variant": attrs.variant }),
      },
      message: {
        default: "This is an alert message",
        parseHTML: (el) => el.getAttribute("data-message"),
        renderHTML: (attrs) => ({ "data-message": attrs.message }),
      },
      // Required: block ID tracking for the BlockDoc format
      "data-block-id": {
        default: null,
        parseHTML: (el) => el.getAttribute("data-block-id"),
        renderHTML: (attrs) => {
          if (!attrs["data-block-id"]) return {}
          return { "data-block-id": attrs["data-block-id"] }
        },
      },
    }
  },

  parseHTML() {
    return [{ tag: "div[data-block-type='alert']" }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", { "data-block-type": "alert", ...HTMLAttributes }, 0]
  },

  addNodeView() {
    return ReactNodeViewRenderer(AlertNodeView)
  },
})
```

**Key rules for extensions:**

- `name` must exactly match your block `type`
- `group: "block"` makes it a top-level block
- `content: "text*"` for text content, `"block+"` for container blocks, or empty string for void blocks (like dividers)
- Always include a `data-block-id` attribute
- `parseHTML` should match on `data-block-type` attribute
- `renderHTML` must output `data-block-type` for round-trip HTML parsing
- Use `ReactNodeViewRenderer` for custom editor rendering

### 3. Editor Node View (`AlertNodeView.tsx`)

This controls how the block looks in the admin editor while editing:

```tsx
import React from "react"
import { NodeViewWrapper, NodeViewContent } from "@tiptap/react"

export const AlertNodeView = ({ node }: any) => {
  const variant = node.attrs.variant || "info"

  const styles: Record<string, { bg: string; border: string; text: string; icon: string }> = {
    info: { bg: "#dbeafe", border: "#3b82f6", text: "#1e40af", icon: "ℹ️" },
    success: { bg: "#d1fae5", border: "#10b981", text: "#065f46", icon: "✓" },
    warning: { bg: "#fef3c7", border: "#f59e0b", text: "#92400e", icon: "⚠️" },
    error: { bg: "#fee2e2", border: "#ef4444", text: "#991b1b", icon: "✕" },
  }

  const style = styles[variant] || styles.info

  return (
    <NodeViewWrapper>
      <div
        style={{
          padding: "1rem 1.25rem",
          backgroundColor: style.bg,
          border: `2px solid ${style.border}`,
          borderRadius: "0.5rem",
          color: style.text,
          marginBottom: "1rem",
          display: "flex",
          alignItems: "flex-start",
          gap: "0.75rem",
        }}
      >
        <span style={{ fontSize: "1.25rem", flexShrink: 0 }}>{style.icon}</span>
        <div style={{ flex: 1 }}>
          <strong style={{ display: "block", marginBottom: "0.25rem", textTransform: "capitalize" }}>{variant}</strong>
          {/* NodeViewContent makes the text area editable */}
          <NodeViewContent as="div" />
        </div>
      </div>
    </NodeViewWrapper>
  )
}
```

**Key points:**

- Always wrap in `<NodeViewWrapper>` — TipTap requires this
- Use `<NodeViewContent>` for editable regions — this is where users type
- Access attributes via `node.attrs`
- Style it to match your SSR component for visual consistency

### 4. Block Index (`index.ts`)

This file ties everything together with three named exports:

```typescript
import type { BlockConfig } from "../../../../src/components/blocks/types"
import type { Block } from "../../../../gl-admin/components/editor/blocks/index"
import AlertBlock from "./AlertBlock.tsx"
import { AlertExtension } from "./AlertExtension"

// 1. SSR block config — used by BlockRenderer on the frontend
export const alertConfig: BlockConfig = {
  type: "alert",
  name: "Alert",
  category: "design",
  description: "Colored alert box for important messages",
  icon: "⚠️",
  keywords: ["alert", "warning", "notice", "callout"],
  priority: 60,
  component: AlertBlock,
  hasChildren: false,
  attributes: {
    variant: { type: "string", default: "info", enum: ["info", "success", "warning", "error"] },
    message: { type: "string", default: "This is an alert message" },
  },
}

// 2. Editor slash command config — appears in the "/" menu in the editor
export const alertEditorConfig: Block = {
  title: "Alert",
  description: "Colored alert box for important messages",
  icon: "⚠️",
  aliases: ["alert", "warning", "notice", "callout"],
  command: ({ editor, range }) => {
    editor
      .chain()
      .focus()
      .deleteRange(range)
      .insertContent({
        type: "alert",
        attrs: { variant: "info", message: "This is an alert message" },
        content: [{ type: "text", text: "This is an alert message" }],
      })
      .run()
  },
}

// 3. TipTap extension — registered in the editor schema
export const alertExtension = AlertExtension

// Default export for SSR registry
export default alertConfig
```

**Export naming convention:**

The system uses a flexible lookup to find your exports:

| Export        | Discovery pattern                                                                       |
| ------------- | --------------------------------------------------------------------------------------- |
| SSR config    | `default` export, or any export matching `BlockConfig` shape (has `type` + `component`) |
| Editor config | `{type}EditorConfig`, or `editorConfig`, or any export with `title` + `command`         |
| Extension     | `{type}Extension`, or `extension`, or any TipTap `Extension`/`Node` export              |

You can use any naming convention — the registry will find your exports. The explicit naming (e.g. `alertConfig`, `alertEditorConfig`, `alertExtension`) is recommended for clarity.

### 5. Register in `theme.config.ts`

Add your block to the `blocks[]` array:

```typescript
blocks: [
  {
    type: "alert",
    modulePath: "/themes/my-theme/blocks/Alert/index.ts",
  },
]
```

- `type` must match the TipTap extension `name` and the `BlockConfig.type`
- `modulePath` is an absolute path from the web root

### Built-in Block Types

These are always available and don't need registration:

| Type           | Description                                               |
| -------------- | --------------------------------------------------------- |
| `paragraph`    | Text paragraph with alignment support                     |
| `heading`      | Heading levels 1-3                                        |
| `blockquote`   | Block quote                                               |
| `code_block`   | Code block with syntax highlighting                       |
| `divider`      | Horizontal rule                                           |
| `image`        | Image with alt text, title, and media library integration |
| `bullet_list`  | Unordered list                                            |
| `ordered_list` | Ordered list                                              |

Custom blocks can use any `type` string not in this list. The block type system is fully extensible — custom types are automatically handled throughout the persistence pipeline (save, load, and render).

---

## Design Tokens & Dark Mode

The full config format supports design tokens for colors, typography, and layout. These are declared in `theme.config.ts` and can be used in your SCSS/CSS.

### Colors

Define light and dark palettes using space-separated RGB values:

```typescript
colors: {
  light: {
    primary: "59 130 246",     // Use in CSS: rgb(var(--color-primary))
    background: "255 255 255",
    text: "15 23 42",
    // ... etc
  },
  dark: {
    primary: "96 165 250",
    background: "15 23 42",
    text: "241 245 249",
  },
}
```

### Dark Mode

Configure dark mode behavior:

```typescript
darkMode: {
  strategy: "class",                  // "class" = toggle via attribute, "media" = OS preference
  attribute: "data-theme",            // Which HTML attribute to set
  defaultMode: "system",              // Initial mode: "light", "dark", or "system"
  storageKey: "gl-theme-preference",  // localStorage key for user preference
}
```

Example FOUC-prevention script (include in `<head>`):

```html
<script is:inline>
  ;(function () {
    const stored = localStorage.getItem("gl-theme-preference") || "light"
    let theme = stored
    if (stored === "system") {
      theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
    }
    document.documentElement.setAttribute("data-theme", theme)
  })()
</script>
```

---

## How Theme Loading Works

Understanding the full lifecycle helps when debugging:

### 1. Backend Discovery (Go)

- `ScanThemesDirectory()` reads `web/themes/*/`
- Validates each theme has `theme.config.ts` and required layouts
- Parses config metadata (name, version, author, description)
- `SyncThemesToDatabase()` creates/updates/deletes theme rows, preserves active flag

### 2. Middleware (Every Request)

1. Fetches active theme from Go backend (`GET /themes/active`)
2. Dynamically imports `theme.config.ts` → injects `themeAssets` into `Astro.locals`
3. Dynamically imports `functions.ts` (if it exists):
   - Creates `ThemeFunctionsContext` with API client and settings
   - Runs `setup()` once (guarded by flag)
   - Runs `beforeRender()` on every request
4. Serves static files from `web/themes/` with proper MIME types

### 3. Route Handler (Page Render)

1. Receives request for `/{post_type}/{id}`
2. Fetches post data from the Go backend
3. Resolves layout variant from database (`getPostLayoutVariant()`)
4. Glob-imports all theme layouts: `import.meta.glob('../../../themes/*/layouts/**/*.astro')`
5. Loads the matching layout: `themes/{themeSlug}/layouts/{postType}/{variant}.astro`
6. Falls back to `themes/default/layouts/...` if the active theme's layout doesn't exist
7. Applies `filterContent()` if the theme defines it
8. Renders the layout with `{ post, title, description }` props

### 4. Admin Editor (Block Editing)

1. `ThemeContext` reads `window.__ACTIVE_THEME__` (injected by middleware)
2. Dynamically imports the active theme's `theme.config.ts`
3. Registers custom TipTap extensions from `blocks[]` → editor schema knows about custom blocks
4. Registers custom editor blocks → slash command menu shows custom blocks
5. Registers SSR block configs → block registry has render components

---

## Best Practices

### Use Type Safety

```typescript
import { defineThemeFunctions } from "../../src/lib/theme-api"
import type { ThemeFunctionsContext, ThemeEndpoint } from "../../src/lib/theme-api"

export default defineThemeFunctions({
  setup: async (context) => {
    /* TypeScript validates this */
  },
})
```

### Handle Errors Gracefully

```typescript
async function beforeRender(context: ThemeFunctionsContext): Promise<void> {
  try {
    context.locals.recentPosts = await context.apiClient.getPosts({ limit: 5 })
  } catch (error) {
    console.error("[Theme] Failed to load recent posts:", error)
    context.locals.recentPosts = [] // Always set fallback data
  }
}
```

### Cache Expensive Operations

```typescript
async function beforeRender(context: ThemeFunctionsContext): Promise<void> {
  let cached = await context.settings.get("cached_popular_posts")

  if (!cached || cached.timestamp < Date.now() - 3600000) {
    const posts = await context.apiClient.getPosts({ limit: 10 })
    cached = { posts, timestamp: Date.now() }
    await context.settings.set("cached_popular_posts", cached)
  }

  context.locals.popularPosts = cached.posts
}
```

### Use Descriptive Local Names

```typescript
// Good — clear what the data is
context.locals.headerNavigationMenu = menu
context.locals.homepageFeaturedPosts = featured

// Bad — ambiguous
context.locals.data = menu
context.locals.posts = featured
```

### Match Editor and SSR Styles

Keep your `AlertNodeView.tsx` (editor) and `AlertBlock.tsx` (frontend) visually consistent. Users expect WYSIWYG — what they see in the editor should match the published page.

### Use a Base Layout

For themes with a consistent header/footer, extract shared markup into `base.astro` rather than duplicating it across every layout variant.

---

## Security Guidelines

### Timeout Protection

All theme functions have a **5-second timeout**. Long operations will be killed:

```typescript
// ❌ Bad — might timeout
await someVerySlowOperation()

// ✅ Good — cache results in settings
const cached = await context.settings.get("expensive_result")
if (!cached) {
  const result = await context.apiClient.getPosts({ limit: 5 })
  await context.settings.set("expensive_result", result)
}
```

### Input Validation

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
}
```

### Authentication

Check `context.user` in endpoints that need auth:

```typescript
handler: async (context) => {
  if (!context.user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })
  }
}
```

### Settings Isolation

Theme settings are automatically namespaced by slug. Your theme cannot access another theme's settings, and vice versa.

---

## Troubleshooting

### Frontend renders blank page

**Symptom:** The page loads but content area is empty.

**Cause:** Layout uses `set:html={post.content}` or similar — but `Post` has no `content` field.

**Fix:** Always use BlockRenderer:

```astro
<BlockRenderer doc={post.published_blocks} client:load />
```

### Custom block not appearing in slash menu

**Symptom:** Typing `/alert` in the editor shows nothing.

**Solutions:**

1. Verify `blocks[]` in `theme.config.ts` has the correct `type` and `modulePath`
2. Check that `index.ts` exports an editor config with `title`, `description`, and `command`
3. Ensure the TipTap extension is exported (the schema must know about the node type)
4. Check browser console for import errors

### "Unknown node type" error in editor

**Symptom:** Console shows `Unknown node type: alert` when loading a post.

**Cause:** The TipTap extension wasn't registered before the editor initialized.

**Fix:** The `ThemeContext` should load extensions before the editor. If you see this, ensure:

1. The extension is exported from your block's `index.ts`
2. The `modulePath` in `theme.config.ts` is correct
3. The theme is active

### Custom block saves but disappears on reload

**Symptom:** Block is visible while editing, but gone after page refresh.

**Solutions:**

1. Verify the extension `name` matches the block `type` exactly
2. Ensure the `data-block-id` attribute is defined in `addAttributes()`
3. Check the saved data in the API response — `published_blocks` should contain your block type

### Theme functions not loading

**Symptom:** `beforeRender` hook not executing, locals are undefined.

**Solutions:**

1. File must be named exactly `functions.ts`
2. Must use `export default defineThemeFunctions({ ... })`
3. Check server terminal for import errors
4. Verify theme is active in database

### Custom endpoints return 404

**Symptom:** `/api/theme/featured` returns 404.

**Solutions:**

1. Verify `path` matches: `{ path: "/featured", ... }` (with leading slash)
2. Ensure `endpoints` array is included in `defineThemeFunctions({ endpoints })`
3. Confirm the theme is active
4. Check for typos in the URL

### Timeout errors

**Symptom:** `Theme function timed out` in server logs.

**Solutions:**

1. Reduce data fetch size (use `limit` parameter)
2. Cache expensive operations in theme settings
3. Move slow operations to custom endpoints (called async from the client)

### Data not appearing in layouts

**Symptom:** `Astro.locals.myData` is `undefined`.

**Solutions:**

1. Verify `beforeRender` sets it: `context.locals.myData = ...`
2. Check server logs for errors in the `beforeRender` hook
3. Ensure the theme loaded successfully (check middleware logs)
4. Restart the dev server

---

## Reference

### File Locations

| File                                                        | Purpose                                       |
| ----------------------------------------------------------- | --------------------------------------------- |
| `web/themes/*/theme.config.ts`                              | Theme configuration                           |
| `web/themes/*/functions.ts`                                 | Server-side hooks                             |
| `web/themes/*/layouts/**/*.astro`                           | Layout templates                              |
| `web/themes/*/blocks/*/index.ts`                            | Custom block modules                          |
| `web/src/lib/theme-api.ts`                                  | Type definitions for functions API            |
| `web/src/components/blocks/types.ts`                        | `BlockConfig` and `BlockComponentProps` types |
| `web/src/components/BlockRenderer.tsx`                      | SSR block renderer                            |
| `web/src/components/blocks/registry.ts`                     | SSR block registry                            |
| `web/src/middleware/index.ts`                               | Theme middleware                              |
| `web/src/pages/[post_type]/[id].astro`                      | Route handler                                 |
| `web/gl-admin/lib/blocks-spec/index.ts`                     | `BlockDocV1`, `Block`, `BlockType` types      |
| `web/gl-admin/contexts/ThemeContext.tsx`                    | Admin theme loading                           |
| `web/gl-admin/components/editor/blocks/index.ts`            | Editor block registry                         |
| `web/gl-admin/components/editor/utils/extensionRegistry.ts` | TipTap extension registry                     |

### Example Themes

| Theme             | Description                                                               |
| ----------------- | ------------------------------------------------------------------------- |
| `themes/default/` | Base theme with SCSS, dark mode, base layout, multiple variants           |
| `themes/test/`    | Magazine-style theme (same structure as default)                          |
| `themes/example/` | Full-featured example with `functions.ts`, custom Alert block, shortcodes |
