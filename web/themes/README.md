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
  - [How blocks are loaded (build time only)](#how-blocks-are-loaded-build-time-only)
  - [Block types are namespaced](#block-types-are-namespaced)
  - [1. Definition (index.ts)](#1-definition-indexts)
  - [2. Editor (editor.ts)](#2-editor-editorts)
  - [3. Public renderer (render.tsx)](#3-public-renderer-rendertsx)
  - [When a theme is removed](#when-a-theme-is-removed)
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
| `register_block_type()`            | a `blocks/<Name>/` directory          |
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
5. **Admin editor** (React + TipTap) has every installed theme block built in (see [Custom Blocks](#custom-blocks))

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
  theme.config.ts              # Required — metadata, assets, layouts
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

  blocks/                      # Custom blocks (optional; see "Custom Blocks")
    Alert/
      index.ts                 # Headless definition: Block Spec + TipTap node (no React)
      editor.ts                # Admin only: node view + slash-menu entry
      render.tsx               # Public renderer (SSR)
      AlertNodeView.tsx        # Anything else the block needs

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

This is the only required file beyond layouts. It defines your theme's metadata, assets and layout variants. Custom blocks are not listed here: each `blocks/<Name>/` directory is one (see [Custom Blocks](#custom-blocks)).

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
  description: string // Plain-text excerpt (for meta tag)
  seo?: SeoMeta // Canonical URL, featured image, og:type... (see SEO tags below)
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

### SEO tags

Render `src/components/SeoHead.astro` in your `<head>` instead of your own `<title>` and description meta, and pass it the `seo` prop the post route gives every layout. It adds the canonical URL (on `SITE_URL`, following the id/slug/category URL setting), `og:*`/`twitter:*` tags with the featured image, and `robots: noindex` when `seo.noindex` is set (use that in `layouts/error/*.astro`). Error responses and `/gl-admin` also get an `X-Robots-Tag: noindex` header from the middleware, whatever the layout emits. `/robots.txt` and `/sitemap.xml` are built by the core, not by themes.

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

### Page Templates

Each page picks one of the active theme's page layouts as its **template** (the editor's Template field; the Pages list shows it). The choices are the `.astro` files in `layouts/page/`, so a new file is a new template once the images are rebuilt. Name and describe them in `theme.config.ts`:

```typescript
layouts: {
  page: {
    default: { file: "layouts/page/default.astro", label: "Default", description: "One reading column" },
    landing: { file: "layouts/page/landing.astro", label: "Landing", description: "A hero, then full-width sections" },
  },
}
```

- `default` is listed first and is required (`layouts/page/default.astro`).
- A file without an entry is still offered, labelled from its name (`full-width.astro` → "Full width"); an entry without its file is not.
- Names are the file names: letters, digits, `-` and `_`.
- A page's template is a setting like its title: on a published page a new template goes live on **Update**.
- **Switching themes:** a page whose template the new theme doesn't have renders with the new theme's `default` page layout. Its choice is kept, so switching back brings it back.

The site's **front page** (Settings › General) is a page too: `/` renders it with its template, and its canonical address is `/`.

### Term Archives and Descriptions

A category or tag page (`/{taxonomy}/{slug}`, e.g. `/category/guides`) renders the theme's `layouts/term/default.astro` (the default theme's when yours has none). It gets `term` (`name`, `slug`, `description`, `taxonomy`, `taxonomy_label`, `hierarchical`), `postCount` and `list` (the posts, pagination and site title), plus `title`, `description` and `seo`. **`term.description`** is the text editors write in Taxonomies (#331: "Shown on the category page if your theme supports it"): show it when it isn't empty, as plain text (it is never HTML). The page's meta description already uses it. A post's terms (`publishedTerms` on the post page, linked by `linkTerms`) carry their `description` too.

Each post has **one category** (#331), "Uncategorized" when none is chosen; categories nest one level. With Settings › General's "By category" URL structure a post's address is `/{category}/{slug}`: always build post links with `postPath` (`@/lib/seo`), which reads the post's `category_slug`, never by hand.

### Base Layouts

For themes with shared HTML structure (header, footer, meta tags), create a `base.astro` wrapper:

```astro
---
// layouts/base.astro
import themeConfig from '../theme.config'
import SeoHead from '@/components/SeoHead.astro'
import type { SeoMeta } from '@/lib/seo'

interface Props {
  title: string
  description: string
  seo?: SeoMeta
}

const { title, description, seo = {} } = Astro.props
const themeAssets = Astro.locals.themeAssets || {}
---

<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width" />
    <!-- <title>, description, canonical, robots, Open Graph, Twitter -->
    <SeoHead title={title} description={description} {...seo} />

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
  seo?: SeoMeta
}

const { post, title, description, seo } = Astro.props
---

<BaseLayout title={title} description={description} seo={seo}>
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
- Every installed theme block's `render.tsx` is registered when the image is built (a block of a removed theme renders nothing)
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
    log.error("theme_menu_load_failed", { error })
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
| `getPosts(params?)`        | A public type's published posts (`/public/posts`; `postType` (default `post`), `limit`, `offset`; `status` is ignored) |
| `getPost(id)`              | A published post by ID (`/public/posts/:id`), or null       |
| `registerPostType(config)` | Register a custom post type                                    |
| `getTaxonomyTerms(type)`   | Get taxonomy terms                                             |
| `getMedia(params?)`        | Media items (`/api/v1/media`: needs a signed-in token, #393) |

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

Themes can define custom block types that appear in the admin editor's slash command menu, are edited live by several people at once, are stored and published like core blocks, and render on the public site. The example theme's `Alert` block (`themes/example/blocks/Alert/`) is the reference.

### How blocks are loaded (build time only)

A block is a directory, not a `theme.config.ts` entry:

```
themes/<slug>/blocks/<Name>/
  index.ts      # Headless definition: Block Spec + TipTap node. No React, no DOM.
  editor.ts     # Admin only: the node with its React node view, and the slash-menu entry.
  render.tsx    # The public renderer (server-side React).
```

Every image resolves these files **when it is built**, never by URL at runtime (the production web server can't serve TypeScript):

| Consumer             | Loads                    | How                                                    |
| -------------------- | ------------------------ | ------------------------------------------------------ |
| Admin editor         | `index.ts` + `editor.ts` | Vite `import.meta.glob` (`gl-admin/lib/theme-blocks/`) |
| Public site (SSR)    | `index.ts` + `render.tsx`| Vite `import.meta.glob` (`src/components/blocks/registry.ts`) |
| Collab server        | `index.ts` only          | esbuild bundle (`collab-server/importMetaGlob.mjs`)    |
| API (Go)             | `themes/blocks.manifest.json` | Generated from `index.ts` by `npm run themes:manifest` |

> **Adding or changing a block means rebuilding the web, collab and api images** (from the same commit), after running `npm run themes:manifest` in `web/` and committing `themes/blocks.manifest.json`. `npm run build` and the test suite (`themeBlocks.loadable.test.ts`) fail if the manifest is stale or a block directory isn't loadable.

Every **installed** block (every block in the build) works whichever theme is active: the editor can edit it, the collab server stores it, the API validates it, and the public page renders it. Only the slash menu is per theme: it offers the active theme's blocks.

### Block types are namespaced

A block's type is `theme:<slug>/<block>`, e.g. `theme:example/alert`. It is also the ProseMirror node name. `<slug>` must be the theme's directory name (letters, digits, `-` and `_`), `<block>` lowercase letters, digits and `-`. Core types never contain `:`, so a theme block can't shadow a core block or another theme's. A build refuses a type outside the theme's namespace or declared twice.

### 1. Definition (`index.ts`)

```typescript
import { defineThemeBlock } from "@gl-admin/lib/theme-blocks/define"

export const ALERT_VARIANTS = ["info", "success", "warning", "error"] as const

export default defineThemeBlock({
  type: "theme:example/alert",
  version: 1,
  title: "Alert",
  attrs: {
    variant: { type: "string", enum: ALERT_VARIANTS, default: "info" },
  },
  content: "inline*", // default; "" makes a leaf block with attrs only
})
```

- **Keep this file headless:** import only `@gl-admin/lib/theme-blocks/define` and plain code. The collab server bundles it, and its build fails if React or your `editor.ts`/`render.tsx` end up in the bundle.
- `defineThemeBlock` builds the TipTap node for you: name = `type`, `group: "block"`, the declared attrs (plus the `data-block-id` every block needs), and HTML parse/render rules on `div[data-block-type="<type>"]` with `data-<attr>` attributes.
- **Attrs** are JSON scalars: `{ type: "string", default, enum?, maxLength? }`, `{ type: "number", default, enum?, integer?, minimum?, maximum? }` or `{ type: "boolean", default }`. Names are camelCase letters and digits; `pm`, `text` and anything starting with `on` are reserved. Every attr needs a valid `default`.
- **Content** is a ProseMirror content expression over **text and text blocks only**: `inline`, `text`, `hardBreak`, `paragraph`, `heading`, `codeBlock`, `horizontalRule` (`inline*`, `text*`, `paragraph+`, `(paragraph | heading)+`, …). A theme block is one node with its content in its `pm`, so anything that holds blocks or media would hide them there, without block ids and out of reach of the sanitizer's per-type rules, media sync and "Used in": since #414, `block` (it includes images), lists, quotes, images and containers such as `group` are refused when the build collects the block (`THEME_BLOCK_CONTENT_NAMES`, `lib/theme-blocks/installed.ts`). A theme block can't define child node types. Theme *containers* (a theme block whose children are real blocks) are a later, separate design.
- **Version:** the newest Block.version your renderer reads. Bump it when you change what a stored attr means; a stored block with a newer version than the build reads is kept but hidden from the editor.

**What is stored** (`block_doc`, Block Spec v1):

```json
{
  "id": "…",
  "type": "theme:example/alert",
  "version": 1,
  "attrs": {
    "variant": "warning",
    "pm": { "type": "theme:example/alert", "content": [{ "type": "text", "text": "Mind the gap" }] },
    "text": "Mind the gap"
  }
}
```

Declared attrs live on the block's `attrs`, the content in `attrs.pm` (and its plain text in `attrs.text`, which search indexes). The API strips undeclared attrs and refuses invalid values, with the same rules the collab server applies before it stores.

### 2. Editor (`editor.ts`)

```typescript
import { themeBlockEditor } from "@gl-admin/lib/theme-blocks/editor"
import alert from "./index"
import { AlertNodeView } from "./AlertNodeView"

export default themeBlockEditor(alert, {
  nodeView: AlertNodeView,
  icon: "⚠️",
  description: "Colored alert box for important messages",
  group: "text",
  keywords: ["warning", "notice", "callout"],
})
```

The block is listed in the editor's block menus (the slash menu and the + in the margin, #415) by its definition's `title`, in `group` (`text`, the default, `media`, `layout` or `embeds`; Advanced is for core admin-only blocks), with `icon` (a short glyph) in its tile. Search matches the start of any word of the title and the start of any `keywords` entry (`aliases`, the older name, still works). The menus only offer the active theme's blocks.

The node view is a normal TipTap React node view (`ReactNodeViewProps`): wrap it in `<NodeViewWrapper>`, put `<NodeViewContent>` where people type, read attrs from `node.attrs` and change them with `updateAttributes` (every collaborator sees the change). Mark controls that aren't text `contentEditable={false}`, and disable them when `!editor.isEditable` (read-only viewers). Don't add schema in the node view: it must stay the definition's node.

### 3. Public renderer (`render.tsx`)

```tsx
import React from "react"
import type { BlockComponentProps } from "@/components/blocks/types"
import { themeBlockAttrs } from "@gl-admin/lib/blocks-spec/themeBlocks"
import alert from "./index"

const AlertBlock: React.FC<BlockComponentProps> = ({ block, getBlockContent }) => {
  const { variant } = themeBlockAttrs(alert, block.attrs) // declared attrs, with defaults
  return (
    <div className={`my-alert my-alert--${variant}`} role="note">
      {getBlockContent(block)}
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
| `anchorId`        | `string \| undefined`               | `b-<block id>` for a top-level block: put it on your root element as its `id` |

**Put `anchorId` on your root element** (`<div id={anchorId} …>`): the editor's "Copy link to block" (#356) links to `/<post url>#b-<block id>`, and that id is how the link finds your block. It is set for top-level blocks only.

Read attrs through `themeBlockAttrs`: it applies defaults and ignores invalid values. A block can render under any active theme (it stays installed), so either style it inline, as the example does, or make sure your class names degrade gracefully without your stylesheet.

### When a theme is removed

Blocks of a theme that is no longer in the build are never deleted. The editor hides them (the post shows a hidden-blocks notice; the rest stays editable) and every save keeps them where they were; the API stores them unvalidated; the public page renders nothing for them. Reinstalling the theme brings them back.

### Built-in Block Types

These are always available and don't need registration:

| Type           | Description                                               |
| -------------- | --------------------------------------------------------- |
| `paragraph`    | Text paragraph with alignment support                     |
| `heading`      | Heading levels 1-6                                        |
| `blockquote`   | Block quote with optional citation                        |
| `code_block`   | Code block with syntax highlighting                       |
| `divider`      | Horizontal rule                                           |
| `image`        | Image with alt text, caption, width and media library integration |
| `bullet_list`  | Unordered list                                            |
| `ordered_list` | Ordered list                                              |
| `list_item`    | A list's item                                             |
| `callout`      | A note in one of four tones (`div.callout.is-info` / `is-success` / `is-warning` / `is-danger`, `role="note"`) |
| `pull_quote`   | A line from the post set large (`figure.pullquote`), optional citation |
| `todo_list`    | A checklist (`ul.todo-list`), read-only checkboxes on the public page |
| `todo_item`    | A to-do list's item, `checked` or not                     |
| `group`        | Blocks kept together (`div.group`, `is-tinted`, `alignwide`/`alignfull`) |
| `details`      | A summary readers open to see its blocks (`<details [open]><summary>`, below) |
| `table`        | Rows and columns with an optional header row and caption (below) |
| `video`        | A video from Media with the browser's player (`figure.video-block > video`), never autoplaying |
| `audio`        | An audio file with the browser's player (`figure.audio-block > audio`) |
| `file`         | A download row (`div.file-block`: `.file-icon`, `.file-text` with the link and `.file-meta` "PDF · 240 KB", `a.btn.file-download`) |
| `gallery`      | Images in a grid (`figure.gallery-block > ul.gallery`, `--cols` the column count), each with its own alt and caption (below) |

**Every theme styles the three #419 blocks** and defines `.sr-only` (the callout says its
tone in a visually hidden span): they render with only their classes
(`themes/textBlocks.test.ts` fails otherwise). The
default theme's callout fills and icon colours are `colors.*.info` / `infoBg` (and `success`,
`warning`, `danger`), `--color-info` / `--color-info-bg` in its stylesheet, checked for
contrast by `themes/default/tokens.test.ts`.

**Details markup (#421).** The browser's own element, so it opens and closes with no script
(a click, or ↵ / Space on the focused summary):

```html
<details id="b-<id>" open>      <!-- `open` only when "Open by default" is on -->
  <summary>…</summary>          <!-- always there, maybe empty; bold, italic and links only -->
  <p>…</p>                      <!-- its blocks, any flow block -->
</details>
```

A theme may hide the browser's marker (`list-style: none` and `::-webkit-details-marker`) and
draw its own; keep the summary's focus ring. The default theme's rules are in
`styles/theme.css`.

**Table markup (#420).** A theme styles it; nothing else is needed:

```html
<figure class="table-block">
  <div class="table-scroll" role="region" tabindex="0" aria-labelledby="b-<id>-caption">
    <table>
      <thead><tr><th scope="col">…</th></tr></thead>  <!-- only with a header row -->
      <tbody><tr><td>…</td></tr></tbody>
    </table>
  </div>
  <figcaption id="b-<id>-caption">…</figcaption>      <!-- only with a caption -->
</figure>
```

Make `.table-scroll` scroll sideways (`overflow-x: auto`) and give the `<table>` a
`min-width`, so a wide table scrolls inside its box on a phone instead of widening the
page; the box is focusable, so show its focus ring (the arrow keys scroll it). Without a
caption the region is named "Table" (`aria-label`). Cells hold paragraphs only, rendered
inline with `<br>` between them. The default theme's rules are in `styles/theme.css`.

**Gallery markup (#424).** A theme lays out the grid; a block with no image left to show renders nothing:

```html
<figure class="gallery-block" id="b-<id>">
  <ul class="gallery" style="--cols: 3">       <!-- 2, 3 or 4 -->
    <li><img …></li>                           <!-- an image block: <figure><img><figcaption> when it has a caption -->
  </ul>
  <figcaption>…</figcaption>                   <!-- only with a caption -->
</figure>
```

Use `repeat(var(--cols, 3), minmax(0, 1fr))` for the columns and drop to two on a phone (the images'
`sizes` say `50vw` below 640px). The default theme crops tiles square (`aspect-ratio: 1 / 1`, the
image's own focal point keeps its subject in frame); its rules are in `styles/theme.css`.

**Inline marks (#418).** Post text may carry `<mark>` (a highlight: one colour, the theme's;
the markup never has a colour of its own), `<sup>` and `<sub>`. Style `mark` with a fill your
text passes 4.5:1 on, in light and dark (a link inside it too), and keep `sup`/`sub` from
opening up the line: the default theme's `styles/theme.css` uses
`font-size: 0.72em; line-height: 0; position: relative; vertical-align: baseline` with
`top: -0.5em` / `bottom: -0.25em`.

**Media blocks (#423).** Video, audio and file render only when the file is there: a block
whose media was deleted is left out with its caption (so is an image), and files come only
from `/uploads`. Give `.video-block video` and `.audio-block audio` the text column's width
and lay `.file-block` out as a row that wraps on a phone; the default theme's rules are in
`styles/theme.css`.

---

## Design Tokens & Dark Mode

The full config format supports design tokens for colors, typography, and layout. These are declared in `theme.config.ts` and can be used in your SCSS/CSS.

### Block colours (required)

The editor's block menu tints a paragraph, heading, quote or list with one of a fixed
palette of tokens (#356, Block Spec `BLOCK_COLORS`: `gray`, `brown`, `orange`, `yellow`,
`green`, `blue`, `purple`, `pink`, `red`), as tinted text or as a tinted block, never both.
The public page renders it as a class on the block: `gl-color-<token>` (text) or
`gl-color-<token>-background` (a fill). **Every theme styles all eighteen classes, for
light and for dark**, from `--block-<token>` / `--block-<token>-background` custom
properties it defines (`themes/blockColors.test.ts` fails otherwise):

```css
:root { --block-red: #ce2c31; --block-red-background: #feebec; /* … */ }
[data-theme="dark"] { --block-red: #ff9592; --block-red-background: #3b1219; /* … */ }
.gl-color-red { color: var(--block-red); }
.gl-color-red-background { background: var(--block-red-background); color: var(--your-text); padding: 0.125em 0.5em; border-radius: 4px; }
```

Pick each text colour so it passes 4.5:1 on your page backgrounds, and each fill so your
body text passes 4.5:1 on it. The default theme keeps them in `theme.config.ts`
(`blockColors`), checked by its `tokens.test.ts`. A block keeps its `b-<block id>` id
for "Copy link to block"; give `[id^="b-"]` a `scroll-margin-top` if your header is sticky.

### Colors

Each palette is a set of hex colours. The default theme (#345) uses these keys; the
seven after `accent` are optional, so older themes that reuse the interface still
type-check:

```typescript
colors: {
  light: {
    primary: "#1b7760",      // links, buttons, focus
    secondary: "#1d3b31",    // headings, site title
    background: "#fdfdfc",
    surface: "#f9f9f8",
    text: "#21201c",
    textMuted: "#63635e",
    border: "#dad9d6",
    accent: "#ffc53d",       // never carries text
    primaryHover: "#145a48",
    onPrimary: "#ffffff",
    primarySubtle: "#e6f7ed",
    surface2: "#f1f0ef",
    borderStrong: "#8d8d86",
    highlight: "#ffe7b3",
    focus: "#1b7760",
  },
  dark: { /* the same keys */ },
}
```

`typography` adds `lineHeight` (tight, snug, normal, relaxed), `layout` adds
`contentWidth`, `wideWidth` and `headerHeight`, and `spacing` / `radius` are scales. The
default theme turns all of them into CSS custom properties in `base.astro`
(`themes/default/tokens.ts`: `--color-text-muted`, `--color-surface-2`, `--size-2xl`,
`--leading-relaxed`, `--space-6`, `--radius-md`, …), so its stylesheet only reads
`var(--…)`. `themes/default/tokens.test.ts` checks every text pairing for 4.5:1 in both
palettes.

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

Set the theme before the first paint with a plain, render-blocking `<script src>` in
`<head>`, not an inline script, so it also works under a Content-Security-Policy of
`script-src 'self'`. The default theme's `scripts/theme-init.js` does this and wires
its Light / Dark / System switch:

```astro
<script src="/themes/default/scripts/theme-init.js" data-storage-key="gl-theme-preference" is:inline></script>
```

Without JavaScript the default theme's tokens fall back to `prefers-color-scheme`.

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

1. The editor's schema already has every installed theme block (`themes/*/blocks/*/editor.ts`, resolved when the admin is built), whichever theme is active
2. `ThemeContext` reads `window.__ACTIVE_THEME__` (injected by middleware) and loads its `theme.config.ts` from the build
3. The block menus (slash and +) offer the active theme's blocks from the block catalog (`components/editor/blocks/catalog.ts`)

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

Log server-side failures with the web server's logger, `import { log } from "@/lib/log"`
(`../../src/lib/log` from `functions.ts`), not `console`: it writes one JSON line per record
with the request id, like the API (#378). Keep the message a fixed `snake_case` name, put the
variable parts in fields, pass the error as `error`, and never log tokens, cookies or query
strings.

```typescript
async function beforeRender(context: ThemeFunctionsContext): Promise<void> {
  try {
    context.locals.recentPosts = await context.apiClient.getPosts({ limit: 5 })
  } catch (error) {
    log.error("theme_recent_posts_load_failed", { error })
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

Keep your node view (editor) and `render.tsx` (frontend) visually consistent. Users expect WYSIWYG — what they see in the editor should match the published page.

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

1. The theme must be the active one: the block menus only offer the active theme's blocks
2. Search matches the start of a word of the block's `title` or of a `keywords` entry: `/lert` finds nothing, `/alert` does
3. `blocks/<Name>/editor.ts` must default-export `themeBlockEditor(...)`
4. The admin image must have been rebuilt since the block was added (`npm test` runs `themeBlocks.loadable.test.ts`, which names what's wrong)

### "Unknown node type" error in editor

**Symptom:** The editor opens a post read-only, naming a block type it can't show.

**Cause:** The live document has a node type this admin build doesn't have: the web image is older than the collab image, or the type predates namespaced theme blocks (#376).

**Fix:** Rebuild and deploy the web, collab and api images from the same commit.

### Custom block saves but disappears on reload

**Symptom:** Block is visible while editing, but gone after page refresh, or the editor shows "couldn't save".

**Solutions:**

1. The collab image must include the block: rebuild it (it bundles `blocks/*/index.ts`)
2. The api image must have a current `themes/blocks.manifest.json` (`npm run themes:manifest`): an attr value the manifest doesn't allow is refused
3. Check the collab container logs for `collab_store_invalid` (an attr value outside its spec)

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
| `web/themes/*/blocks/*/{index,editor,render}`               | Custom blocks (definition, editor, renderer)  |
| `web/themes/blocks.manifest.json`                           | Theme block specs for the API (generated)     |
| `web/gl-admin/lib/theme-blocks/`                            | `defineThemeBlock`, `themeBlockEditor`, the globs |
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
