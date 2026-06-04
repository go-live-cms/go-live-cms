# Custom Post Types — Implementation Plan (COMPLETED)

Theme-owned custom post types, WordPress-style. Themes declare post types in `theme.config.ts`. When a theme is deactivated, its post types hide from the admin/frontend but data persists. Re-activating restores everything. Post types cannot be deleted.

**Status: All phases (A–F) complete.** Verified end-to-end on 2026-02-23.

---

## Implemented State

| Layer                 | Status                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| DB `post_types` table | Full schema + `is_active` bool + `registered_by` varchar (migration 000008)                                   |
| DB queries (sqlc)     | Full CRUD + UpsertPostType, ListActivePostTypes, SetPostTypeActive, SetPostTypeActiveByRegisteredBy           |
| Go API handlers       | GET (active filter, `?all=true`), POST (upsert, system-type protection), PUT (update, system-type protection) |
| Go theme scanner      | Bracket-counting parser for `postTypes` array, syncs to DB on startup with `registered_by: "theme:{slug}"`    |
| Theme activation      | Toggles `is_active` via `SetPostTypeActiveByRegisteredBy` on theme switch                                     |
| Astro frontend routes | Dynamic — fetches post types from API, fallback to `['post','page']`                                          |
| Layout fallback       | 5-step chain: theme+type+variant → theme+post+variant → theme+post+default → default+type → default+post      |
| Admin UI routes       | Parameterized `/content/:typeName` and `/content/:typeName/new`                                               |
| Admin sidebar         | Dynamic — fetches post types, sorted by menu_position                                                         |
| Post creation         | Dynamic post type from route params, block editor, correct URL structure                                      |

---

## Design Decisions

- **Themes own post types** — declared in `theme.config.ts`, synced via `setup()` hook
- **Deactivation hides, doesn't delete** — post type hidden from admin/frontend, data stays in `posts` table
- **Re-activation auto-restores** — no manual confirmation needed
- **No deletion** — post types cannot be deleted
- **`registered_by` column** — tracks ownership (`"system"` for post/page, `"theme:{slug}"` for theme types)
- **`is_active` column** — efficiently filters without re-parsing configs per request
- **Layout fallback** — custom type → theme's post/default.astro → default theme's post/default.astro

---

## Steps

### Phase A: Backend (Go)

#### Step 1: Database migration — add `is_active` + `registered_by` columns

- [x] Migration `000008`: `ALTER TABLE post_types ADD COLUMN is_active boolean NOT NULL DEFAULT true`
- [x] Migration `000008`: `ALTER TABLE post_types ADD COLUMN registered_by varchar NOT NULL DEFAULT 'system'`
- [x] Existing `post` and `page` rows remain `is_active = true`, `registered_by = 'system'`
- Files: `db/migration/000008_add_post_type_active.up.sql`, `.down.sql`

#### Step 2: Update sqlc queries for `is_active` + `registered_by`

- [x] `ListActivePostTypes` — `WHERE is_active = true`
- [x] `UpsertPostType` — `INSERT ON CONFLICT (name) DO UPDATE` with all fields
- [x] `SetPostTypeActive` — `UPDATE SET is_active = $1 WHERE name = $2`
- [x] `SetPostTypeActiveByRegisteredBy` — `UPDATE SET is_active = $1 WHERE registered_by = $2`
- [x] Regenerated sqlc + mock
- Files: `db/query/post_types.sql`, `db/sqlc/post_types.sql.go`, `db/sqlc/models.go`, `db/mock/store.go`

#### Step 3: Add Create/Update post type API handlers

- [x] `createPostType` — POST `/api/v1/post-types` (upsert semantics, system-type protection)
- [x] `updatePostType` — PUT `/api/v1/post-types/:name` (system-type protection)
- [x] Auth-protected with `authMiddleware`
- [x] `supports` JSON parsed properly in response
- [x] Routes registered in `server.go`
- Files: `api/post_types.go`, `api/server.go`

#### Step 4: Extend theme scanner to parse postTypes from config

- [x] `DiscoveredTheme.PostTypes []DiscoveredPostType` struct field
- [x] `parsePostTypes()` — bracket-counting parser (handles nested `supports` arrays)
- [x] `SyncThemesToDatabase()` — upserts post types with `registered_by: "theme:{slug}"`, `is_active` matches theme status
- [x] System types (`post`, `page`) skipped by parser
- Files: `api/themes_scanner.go`

#### Step 5: Update getPostTypes handler to filter by active

- [x] Returns only `is_active = true` by default
- [x] `?all=true` returns all (for admin)
- [x] `PostTypeResponse` includes `is_active` and `registered_by`
- Files: `api/post_types.go`

### Phase B: Theme Config

#### Step 6: Add postTypes declaration to example theme

- [x] `postTypes` array + TypeScript interface in `theme.config.ts`
- [x] Product type: name, label, description, icon, hierarchical, hasArchive, menuPosition, supports
- Files: `web/themes/example/theme.config.ts`

#### Step 7: Wire up theme functions.ts registerPostType

- [x] `setup()` calls `context.apiClient.registerPostType()` for "product"
- [x] Idempotent — upsert on backend
- Files: `web/themes/example/functions.ts`

#### Step 8: Add product layout to example theme

- [x] Product-specific layout with hero grid, image placeholder, meta tags, BlockRenderer
- Files: `web/themes/example/layouts/product/default.astro`

### Phase C: Frontend Routing

#### Step 9: Dynamic post type routes in Astro

- [x] Both routes fetch from `GET /api/v1/post-types` with `['post','page']` fallback
- [x] Only active post types get routes via `getStaticPaths()`
- Files: `web/src/pages/[post_type]/index.astro`, `web/src/pages/[post_type]/[id].astro`

#### Step 10: Layout fallback chain (5 steps)

- [x] `themes/{theme}/layouts/{postType}/{variant}.astro`
- [x] `themes/{theme}/layouts/post/{variant}.astro`
- [x] `themes/{theme}/layouts/post/default.astro`
- [x] `themes/default/layouts/{postType}/{variant}.astro`
- [x] `themes/default/layouts/post/default.astro`
- Files: `web/src/pages/[post_type]/[id].astro`

### Phase D: Admin UI

#### Step 11: Fetch post types dynamically in admin

- [x] `PostTypeInfo` interface + `getPostTypes()` in SSR API client
- [x] Sidebar fetches on mount, used across admin
- Files: `web/src/lib/api.ts`, `web/gl-admin/lib/api/postTypes.ts`

#### Step 12: Dynamic admin routes

- [x] Parameterized `/content/:typeName` and `/content/:typeName/new`
- [x] Unified `NewContent.tsx` component (replaced separate NewPost/NewPage)
- Files: `web/gl-admin/app.tsx`, `web/gl-admin/pages/NewContent.tsx`

#### Step 13: Dynamic sidebar navigation

- [x] Fetches post types from API, sorted by `menu_position`
- [x] Icon resolution with fallback
- Files: `web/gl-admin/components/sidebar/Sidebar.tsx`

#### Step 14: Update PostForm for dynamic post types

- [x] Post type from route params, dynamic labels (capitalize)
- [x] Removed switch statements in PostForm, EditPost, EditPage
- [x] Dynamic URLs: `/content/${postType}` and `/${postType}/${slug}`
- Files: `web/gl-admin/components/forms/PostForm.tsx`, `web/gl-admin/pages/EditPost.tsx`, `web/gl-admin/pages/EditPage.tsx`

#### Step 15: Update PostType badge component

- [x] `stringToColor()` for deterministic color from arbitrary type names
- [x] Known types (post/page) keep preset colors
- Files: `web/gl-admin/components/ui/PostType.tsx`

### Phase E: Theme Deactivation Flow

#### Step 16–17: Deactivation hides, re-activation restores

- [x] `activateTheme` handler: deactivate old theme's types → activate new theme's types
- [x] Uses `SetPostTypeActiveByRegisteredBy` with `"theme:{slug}"` pattern
- [x] Sidebar, routes, and frontend all respect `is_active` flag
- Files: `api/themes_handlers.go`

### Phase F: Validation & Testing

#### Step 18: Tests + manual E2E verification

- [x] `api/post_types_test.go` — handler tests (get, create, update, filter)
- [x] `api/themes_scanner_test.go` — parser tests (10 scenarios)
- [x] Manual E2E verified: product appears in sidebar, creation works, correct API response
- Files: `api/post_types_test.go`, `api/themes_scanner_test.go`

---

## File Impact Summary (Actual)

| File                                                  | Change                                                 |
| ----------------------------------------------------- | ------------------------------------------------------ |
| `db/migration/000008_add_post_type_active.*`          | `is_active` + `registered_by` columns                  |
| `db/query/post_types.sql`                             | Upsert, ListActive, SetActive, SetActiveByRegisteredBy |
| `db/sqlc/*`                                           | Regenerated                                            |
| `db/mock/store.go`                                    | Regenerated                                            |
| `api/post_types.go`                                   | Create/update handlers + active filtering              |
| `api/post_types_test.go`                              | NEW — handler tests                                    |
| `api/server.go`                                       | POST/PUT routes for post-types                         |
| `api/themes_scanner.go`                               | Bracket-counting parser + post type sync               |
| `api/themes_scanner_test.go`                          | NEW — parser tests                                     |
| `api/themes_handlers.go`                              | Post type toggling on theme activation                 |
| `web/themes/example/theme.config.ts`                  | postTypes interface + product declaration              |
| `web/themes/example/functions.ts`                     | registerPostType in setup()                            |
| `web/themes/example/layouts/product/default.astro`    | NEW — product layout                                   |
| `web/src/lib/api.ts`                                  | PostTypeInfo + getPostTypes()                          |
| `web/src/lib/theme-loader.ts`                         | Widened type param to `string`                         |
| `web/src/pages/[post_type]/index.astro`               | Dynamic post type discovery                            |
| `web/src/pages/[post_type]/[id].astro`                | Dynamic routing + 5-step layout fallback               |
| `web/gl-admin/lib/api/types.ts`                       | PostType interface extended                            |
| `web/gl-admin/app.tsx`                                | Parameterized `/content/:typeName` routes              |
| `web/gl-admin/pages/NewContent.tsx`                   | NEW — unified new content component                    |
| `web/gl-admin/pages/Content.tsx`                      | Dynamic type filter from route params                  |
| `web/gl-admin/components/sidebar/Sidebar.tsx`         | Dynamic content section from API                       |
| `web/gl-admin/components/forms/PostForm.tsx`          | Dynamic post type, removed switches                    |
| `web/gl-admin/pages/EditPost.tsx`                     | Dynamic URLs, removed switches                         |
| `web/gl-admin/pages/EditPage.tsx`                     | Dynamic URLs                                           |
| `web/gl-admin/components/ui/PostType.tsx`             | stringToColor() for dynamic badge colors               |
| `web/gl-admin/components/editor/ui/PublishBarNew.tsx` | Capitalize instead of switch                           |
