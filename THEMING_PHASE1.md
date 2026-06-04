# Theming System - Phase 1 Implementation

## ✅ What We've Built

### 1. Theme File Structure

Created a WordPress-inspired theme system with separate layout files:

```
web/
├── themes/
│   └── default/                          # Default theme
│       ├── theme.config.ts               # Theme configuration (colors, typography, layouts)
│       ├── layouts/
│       │   ├── base.astro                # Base HTML layout
│       │   ├── post/
│       │   │   ├── default.astro         # Centered post layout
│       │   │   ├── sidebar.astro         # Two-column with sidebar
│       │   │   └── wide.astro            # Full-width content
│       │   └── page/
│       │       ├── default.astro         # Standard page layout
│       │       └── fullwidth.astro       # Full-width page
│       └── README.md                     # Theme documentation
├── system-theme/                         # Fallback theme (minimal)
│   └── fallback.astro                    # Error/no-theme fallback
└── src/
    └── lib/
        └── theme-loader.ts               # Theme resolution utilities
```

### 2. Key Architectural Decisions

**✅ Separate Layout Files (Not Conditional Logic)**

- Each layout variant is a separate `.astro` file
- Better developer experience, clearer code organization
- Follows industry best practices (Next.js, SvelteKit, WordPress)
- Easier to maintain and extend with child themes

**✅ Theme Configuration in TypeScript**

- `theme.config.ts` with full type safety
- Defines colors (light/dark), typography, layout metadata
- Easy to extend and validate

**✅ Manual Dark Mode Colors**

- Separate color palettes for light and dark modes
- No automatic color calculation (poor results)
- Professional design system approach

### 3. Theme Configuration Example

```typescript
// themes/default/theme.config.ts
export const themeConfig = {
  name: "Default Theme",
  version: "1.0.0",
  author: "Go Live CMS",

  supports: {
    postTypes: ["post", "page"],
    darkMode: true,
    childThemes: true, // Ready for Phase 2
  },

  colors: {
    light: {
      primary: "59 130 246", // blue-500
      secondary: "100 116 139", // slate-500
      background: "255 255 255", // white
      text: "15 23 42", // slate-900
    },
    dark: {
      primary: "96 165 250", // blue-400 (optimized for dark)
      secondary: "148 163 184", // slate-400
      background: "15 23 42", // slate-900
      text: "241 245 249", // slate-100
    },
  },

  typography: {
    fonts: {
      sans: "system-ui, sans-serif",
      serif: "Georgia, serif",
      mono: "Consolas, monospace",
    },
    scale: {
      sm: "0.875rem",
      base: "1rem",
      lg: "1.125rem",
      xl: "1.25rem",
      "2xl": "1.5rem",
    },
  },

  layouts: {
    post: {
      default: {
        file: "layouts/post/default.astro",
        label: "Default (Centered)",
        description: "Clean, centered layout",
      },
      sidebar: {
        file: "layouts/post/sidebar.astro",
        label: "With Sidebar",
        description: "Two-column with sidebar",
      },
      wide: {
        file: "layouts/post/wide.astro",
        label: "Wide Layout",
        description: "Full-width immersive reading",
      },
    },
    page: {
      default: {
        file: "layouts/page/default.astro",
        label: "Default Page",
      },
      fullwidth: {
        file: "layouts/page/fullwidth.astro",
        label: "Full Width Page",
      },
    },
  },
};
```

### 4. Theme Loader Utilities

```typescript
// web/src/lib/theme-loader.ts

// Get active theme (Phase 1: hardcoded, Phase 2: from DB)
await getActiveThemeId(); // Returns 'default'

// Load theme configuration
const config = await loadThemeConfig("default");

// Get layout path for a post type and variant
const path = await resolveLayoutPath("post", "sidebar");
// Returns: '/themes/default/layouts/post/sidebar.astro'

// Get layout variant for a specific post
const variant = await getPostLayoutVariant(post, "post");
// Phase 1: Always returns 'default'
// Phase 2: Will check database customizations
```

### 5. How It Works

When a user visits `/post/my-article`:

1. **Route matches**: `[post_type]/[id].astro`
2. **Post fetched**: From API via `getPostById()` or `getPostBySlug()`
3. **Layout variant determined**: `getPostLayoutVariant(post, 'post')` → 'default'
4. **Layout component selected**: Maps 'default' to `PostDefault` component
5. **Page rendered**: Using `themes/default/layouts/post/default.astro`

### 6. Layout Variants Comparison

**Default Layout** (`post/default.astro`):

- Centered content (max-width: 720px)
- Featured image at top
- Clean, minimal design

**Sidebar Layout** (`post/sidebar.astro`):

- Two-column grid
- Main content + sidebar
- Recent posts, categories in sidebar

**Wide Layout** (`post/wide.astro`):

- Full-width content (max-width: 1200px)
- Edge-to-edge featured images
- Immersive reading experience

## 🔄 Current Status

### ✅ Completed

- [x] Theme file structure created
- [x] Theme config schema defined
- [x] Three post layout variants (default, sidebar, wide)
- [x] Two page layout variants (default, fullwidth)
- [x] Base layout with dark mode support
- [x] Theme loader utilities
- [x] Integration with existing routing

### ⏳ Phase 2 (Not Yet Implemented)

- [ ] Database schema for theme settings
- [ ] Theme customization API (Go backend)
- [ ] Admin UI for theme selection
- [ ] Color/typography customization
- [ ] Layout variant selection per post
- [ ] Child theme support (file overrides)
- [ ] Theme marketplace/installation

## 🧪 Testing the Theme System

### Verify Theme Structure

```bash
# List theme layouts
ls -la web/themes/default/layouts/post/
# Should show: default.astro, sidebar.astro, wide.astro

ls -la web/themes/default/layouts/page/
# Should show: default.astro, fullwidth.astro
```

### Check Theme Config

```bash
# View theme configuration
cat web/themes/default/theme.config.ts
```

### Test Build (Static Mode)

```bash
cd web
npm run build
# Note: Currently set to static output
# Phase 2 will add @astrojs/node adapter for SSR
```

## 📝 Key Design Principles

1. **Separation of Concerns**
   - Templates (structure) → Files (version controlled)
   - Customizations (values) → Database (Phase 2)
   - Best of both worlds: Git-friendly + user-editable

2. **Developer Experience First**
   - TypeScript type safety
   - VS Code autocomplete
   - Familiar file structure
   - Clear separation of variants

3. **WordPress-Inspired, Not WordPress-Cloned**
   - Learn from WordPress mistakes (version control, performance)
   - Keep what worked (template hierarchy, child themes)
   - Modernize with Astro + TypeScript

4. **Progressive Enhancement**
   - Phase 1: Basic theme structure (file-based)
   - Phase 2: Database customizations, child themes
   - Phase 3: Theme marketplace, patterns library

## 🎨 Next Steps (Phase 2)

1. **Database Schema**
   - `themes` table (id, name, version, active)
   - `theme_customizations` table (key-value pairs)
   - `theme_patterns` table (reusable block combinations)

2. **Go Backend API**
   - `GET /api/themes` - List available themes
   - `PUT /api/themes/:id/activate` - Activate theme
   - `GET /api/themes/:id/customizations` - Get customizations
   - `PUT /api/themes/:id/customizations` - Update colors, fonts, etc.

3. **Admin UI**
   - Theme selection page
   - Live preview with customizations
   - Color picker (light/dark modes)
   - Typography selector
   - Layout variant assignment per post

4. **Child Theme Support**
   - File resolution chain (child → parent → default)
   - Config deep merging
   - Vite alias configuration for imports

## 📚 Documentation

- **Theme Development Guide**: `web/themes/default/README.md`
- **Theme Config Reference**: See `theme.config.ts` TypeDoc comments
- **Layout Guidelines**: Check individual layout file comments

## 🐛 Known Issues / TODOs

- [ ] Build currently fails on blog MDX imports (unrelated to theming)
- [ ] Astro config set to `static` output (needs @astrojs/node adapter for SSR)
- [ ] System fallback theme not fully implemented (commented out dynamic import)
- [ ] Post type doesn't have `featured_image_url` (using `featured_image` instead)
- [ ] Need to add missing Post fields: `published_at`, `author` object

## 🎯 Success Metrics

**Phase 1 Goals**: ✅ Achieved

- ✅ Create foundational theme structure
- ✅ Demonstrate separate layout files approach
- ✅ Establish theme configuration pattern
- ✅ Set up theme loader utilities
- ✅ Document architectural decisions

**Ready for Phase 2**: ✅

- Theme system foundation is solid
- Clear path forward for customization UI
- Database schema design completed (see research notes)
- Child theme architecture planned
