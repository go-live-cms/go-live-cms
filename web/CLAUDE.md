# Web frontend — agent context

**Astro 5 (SSR) + React 19**. Two surfaces:

- `web/src/` — public Astro site (SSR). Renders posts from **Block Spec v1 JSON** via
  `src/components/blocks/` (server-side, no ProseMirror). `output: "server"`.
- `web/gl-admin/` — the admin **React SPA** (React Router, `basename="/gl-admin"`,
  `StrictMode` on in dev). Contains the collaborative editor.

## Path aliases (must match in any tooling)

Defined in `tsconfig.json` **and** `astro.config.mjs` **and** `vitest.config.ts`:

- `@/*` → `src/*`
- `@gl-admin/*` → `gl-admin/*`
- `@themes` → `themes`

## Tests (Vitest — added under #202)

- Runner: **Vitest 4 + jsdom**. Config: `web/vitest.config.ts`. Run with `npm test`
  (`vitest run`) or `npm run test:watch`. Test files: `**/*.test.ts(x)` under
  `gl-admin/`/`src/`.
- **Headless ProseMirror schema** (no TipTap/DOM mount): build with
  `getSchema(extensions)` from `@tiptap/core`. See
  `gl-admin/lib/collaboration/blockBridge.test.ts` for the pattern (StarterKit +
  TextAlign + ImageWithMediaId + **BlockIdExtension**, which supplies the
  `data-block-id` global attr the bridge needs).
- Yjs runs natively in Node — collab code is tested against a real `new Y.Doc()` and the
  real collab server in-process (`hocuspocusRelay.testkit.ts`).
- CI runs `npm test` on **Node 22** (`.github/workflows/ci.yml` `web-tests` job).
  jsdom 29 needs Node ≥20.19, hence 22.

## Editor lives under `gl-admin/`

The collaborative editor and its sync layer (with the collab server in `collab-server/`)
are the most fragile part of the codebase. **Before editing anything under
`gl-admin/components/editor/`, `gl-admin/lib/collaboration/` or `collab-server/`, read
`gl-admin/lib/collaboration/CLAUDE.md`.**

## Misc

- **Auth / 401s:** `apiCall` (`gl-admin/lib/api.ts`) treats a 401 as "the server
  revoked this token". It calls `authManager.forceRefresh()` and retries once,
  ignoring the local expiry, because a password change invalidates access tokens
  early. `/auth/*` endpoints are excluded (there a 401 means bad credentials). A
  failed refresh clears auth, except a **429** (API rate limit, #190): then the user
  stays signed in and `authManager` retries after `Retry-After` (`RefreshError`).
  `blockAPI.ts` (block reads, publish, versions) does NOT go through this: it throws
  `UnauthorizedError` to its caller.

- TipTap is on **v3** (breaking from v2). `setContent`'s 2nd arg is an options object
  `{ emitUpdate }` — NOT the v2 boolean. `emitUpdate:false` only suppresses TipTap's
  `update` event; the collaboration ySyncPlugin still mirrors content to Yjs regardless.
- StarterKit's bundled undo/redo is **disabled when collaborating** (`undoRedo:
  collabProvider ? false : undefined` in `editor/utils/extensions.ts`, #197) —
  Collaboration ships its own Yjs-aware history. Keep it for non-collab editors.
- **`yjs` is pinned to `13.6.31` (exact, no `^`), and `web/` is the only package that
  uses it:** the editor and the collab server share this lockfile. Loose ranges (when
  `websocket/` had its own lockfile, before #285) drifted apart once and contributed to
  collab data corruption. See `gl-admin/lib/collaboration/CLAUDE.md` rule 8 and the
  single-instance section of `collab-server/CLAUDE.md` before touching any yjs-family
  dependency.
- **Production `/api/v1` + `/uploads` forwarding (#143):** the browser calls the API
  same-origin. In dev the Vite proxy (`astro.config.mjs`) forwards those paths; the
  production image runs the standalone `@astrojs/node` server, which has no Vite, so
  `src/middleware/apiProxy.ts` forwards them (first thing in the middleware, skipped in
  dev). It appends the client IP to `X-Forwarded-For`, so the API must list the web
  container in `TRUSTED_PROXIES` (prod `compose.yaml` does). Astro's own `/api/theme` and
  `/api/posts-reload` routes are not under `/api/v1`.
- **Image variants + focal point (#255):** media responses carry `variants`
  (`thumb`/`medium`/`large`, each `{path,width,height,…}`; absent when the image is
  smaller) and `focal_point` (`{x,y}` 0..1 or null). Admin grids/pickers use
  `getMediaVariantPreviewURL(media, size)` (falls back to larger, then the original);
  the media detail page sets the focal point with `FocalPointPicker`. Image blocks keep
  storing the original `src`; the public `ImageBlock` reads the API-attached
  `doc.media[mediaId]` (`blocks/utils/responsiveImage.ts`) for `srcset`/`sizes`/
  `width`/`height`/`object-position`, all URLs through `safeImageSrc`.
- **Server-side API calls use `SERVER_API_URL`, read at runtime** (#272): import
  `SERVER_API_URL` (with `/api/v1`) or `SERVER_MEDIA_URL` (the API origin, e.g. for
  `/public/*` and `/uploads`) from `gl-admin/lib/server-api-url.ts`. Never
  `import.meta.env.PUBLIC_API_URL` or `import.meta.env.SERVER_API_URL` in SSR code:
  Astro inlines them at build time. `PUBLIC_API_URL` is only the browser-facing origin for
  the admin CSP, unset in production.
- **Themes are build-time** (#272): the middleware loads `theme.config.ts` /
  `functions.ts` through `import.meta.glob` maps (`THEME_CONFIGS`, `THEME_FUNCTIONS`), and
  layouts through globs too, all resolved by Vite when the image is built. A theme added
  later has no entry (logged as "not in this build"). The API image ships `web/themes` too, for its startup scan.
- **SEO (#137):** `src/lib/seo.ts` holds the pure helpers (tested in `seo.test.ts`).
  The site URL is `SITE_URL`, read from `process.env` at runtime (`resolveSiteUrl`;
  unset → request origin, wrong behind a proxy, so prod must set it). `/robots.txt`
  and `/sitemap.xml` are server routes (no `@astrojs/sitemap`: it only sees prebuilt
  pages). The sitemap lists only public types and `published` posts, at the URL
  `post_url_structure` gives (`postPath`, same rule as `[id].astro`), lastmod =
  `changed_at`. Heads go through `src/components/SeoHead.astro`; the post route passes
  a `seo` prop that theme layouts forward to their base layout. `.astro` components
  are testable with the Container API in files named `*.astro.test.ts`: they run as
  a separate vitest project (`vitest.astro.config.ts`, Astro's `getViteConfig`, node
  env); the other tests stay in the plain `unit` project. Without `SITE_URL`,
  robots/sitemap are sent `private, no-store` (the URL came from the Host header);
  the sitemap is cached in memory for 10 minutes.
- **App shell (#339):** the sidebar's links come from `components/sidebar/nav.ts`
  (`buildNavigation`, role-filtered with `lib/roles.ts`; tested in `nav.test.ts`). At
  ≤768px it's the shared `Drawer` (`bare`), so focus trap, Escape and focus return are
  Drawer's. Admin-only pages are wrapped in `RequireRole` in `app.tsx` (the 403 page).
  Full-page errors live in `components/errors/ErrorPages.tsx`; `errorPageFor`
  (`lib/errorPages.ts`) maps an `ApiError` to 404 / 403 / the generic page, whose error
  ID is `ApiError.requestId` (the API's `request_id`). Pages that fail their main load
  render `<ErrorPage error={…}>` or throw into the `ErrorBoundary`, which does the same.
- **Posts, Pages and Home (#340):** the list rules (status tabs and counts, the
  contributor's "Your access", row actions, sort, "last edited") live in
  `lib/contentList.ts`, the Pages tree in `lib/pageTree.ts` (both tested). Counts come from
  `GET /posts/counts`; `status` takes a comma list, and "All" is `draft,published`
  (archived posts are left out). List rows fetched with `with_meta=true` carry `authors`
  (user_posts). Hierarchical types render `pages/Pages.tsx`, which loads every page for
  the tree. Features without a backend yet stay hidden (comments at the top of each page).
- **Editor chrome (#341):** `components/editor/ui/EditorTopBar.tsx` (breadcrumb, status,
  save/connection state, presence, publish menu), `PostSidebar` (Post · History), History
  preview in the canvas (`RevisionsPanel`'s `VersionPreview`; the bound editor stays mounted,
  only hidden). Connection states and the unload warning are `utils/connectionState.ts`
  (tested): no change for `RECONNECT_GRACE_MS`, then "reconnecting", then offline; the tab
  warns on unload while the provider has unsynced changes or the connection is down. Editor
  styles use the design tokens only (never `prefers-color-scheme`). Features in the design
  without a backend stay hidden (comments at the top of each file; table on #341).
- **Workspace screens (#343):** Users, Taxonomies, Settings, Themes, Profile and the new
  Post types page (`/post-types`, admin only) share `assets/styles/pages/workspace.scss`
  (header, list + side panel, field grids). Their rules live in `lib/settingsForm.ts`
  (dirty fields and the unsaved-changes bar's message), `lib/postTypes.ts` (PUT resets
  missing booleans and clears an empty description, so the form sends every field; Posts
  and Pages are built in and read-only), `lib/roles.ts` (`ROLE_DESCRIPTIONS` for the
  invite dialog) and `lib/profile.ts` (`newPasswordChecklist`: #344's `passwordRule`, the
  API's real minimum, plus "different from the current one"). `Input` masks
  refuse characters such as `! & : ?`; pass `unmasked` for free text the API validates.
  Saving a post type fires `POST_TYPES_CHANGED` so the sidebar reloads its menu.
- **Media library and detail (#342):** `/media` (grid, side panel for `?file=id`, at
  ≤768px a Drawer) and `/media/:id` (focal point with crop previews, Replace, fields,
  "Used in"). The rules (kinds, tags, filters, "Used in" rows, object-position) live in
  `lib/mediaLibrary.ts` (tested). "Used in" is `GET /media/:id/posts`, i.e. `post_media`:
  the featured image (order 0) and the image blocks the collab store syncs (> 0), merged
  per post. Write access is `canWriteMedia` (`lib/roles.ts`). Hidden until #325: the
  "No alt text" tag/filter and "Decorative image".
- **Account pages (#344):** `/login`, `/forgot-password`, `/reset-password` and
  `/accept-invite` are Astro pages (no React) on `src/layouts/AccountPage.astro`, styled by
  `pages/login.scss` with the #338 class names (`gl-input`, `gl-button`, `gl-notice`,
  `gl-avatar`). Each page's `<script>` only calls a mount function in
  `lib/accountPages.ts` or `lib/loginPage.ts` (admin CSP: no inline scripts); the
  shared pieces are `components/account/`. The password minimum is `PASSWORD_MIN` in
  `lib/passwordRules.ts` (import-free, so pages render the hint server-side);
  `passwordRules.test.ts` fails if the API's `min=` differs. The invite preview returns
  `invited_by` `{id, name}` or null.
- **Image caption/width, quote citation (#346):** image and blockquote are Block Spec v2
  (`caption`, `align`; `cite`); the mapping and its rules are in
  `gl-admin/lib/collaboration/CLAUDE.md` (blockBridge notes). Public markup, which the
  theme styles: an image with neither a caption nor a width stays a bare `<img>`;
  otherwise `<figure class="align-wide|align-full">` (no class for inline) with
  `<figcaption>`, and `<cite>` as the last child of `<blockquote>`. The image toolbar is
  `components/editor/ui/ImageToolbar.tsx` (shown on a selected image; the text bubble
  menu hides then, and in a caption shows only bold/italic/link).
- **Default public theme (#345):** tokens live in `themes/default/theme.config.ts` and
  become CSS custom properties in `base.astro` (`tokens.ts`); `styles/theme.css` is plain
  CSS served as is and only reads `var(--…)` (`tokens.test.ts` checks 4.5:1 in both
  palettes and that every `var()` is defined). Fonts are self-hosted under
  `themes/default/fonts/`. The Light / Dark / System switch is `scripts/theme-init.js`,
  a render-blocking `<script src>` (never inline, so it survives a `script-src 'self'`
  CSP). `/` and `/{post_type}` render the theme's `layouts/home` and `layouts/archive`
  through `lib/themeLayout.ts` (default theme as fallback), with data from
  `lib/postList.ts`. Parts without a backend stay hidden (table in
  `themes/default/README.md`). `/themes/active` returns `settings` as an object (it was
  base64 before, so `layout_variants` never applied).
- **Heading anchors, related/adjacent posts (#351):** `BlockRenderer` gives every heading an
  `id` from `blocks/utils/headingAnchors.ts` (slug of the text, Latin accents dropped, other
  scripts kept, `-2`/`-3` for repeats, reserved ids skipped); a layout that also builds a
  table of contents passes its `headings` so both agree. Older/newer and related posts come
  from the API's `/public/posts/:id/adjacent` and `/related` through `lib/relatedPosts.ts`
  (`loadPostEnd`, every part fails soft).
- **Numbered pagination (#349):** lists page through `GET /public/posts/type/:type?page=N`
  (published only, `posts_per_page` from settings, `{posts, pagination: {page, per_page,
  total, total_pages}}`, 404 past the end; Go helpers in `api/pagination.go`). URLs,
  the `1 2 3 … 5` window and `?page=` handling are `src/lib/pagination.ts`
  (`resolveListRequest`); the pager is `src/components/Pagination.astro`; `listSeo` gives
  the canonical and `rel="prev"/"next"` for `SeoHead`. Page 1 has no suffix, page N is
  `<base>/page/N/`. `[post_type]/page/[n].astro` and, for `/page/N/`, `[id].astro` set
  `Astro.locals.listPageNumber` and `Astro.rewrite` to the list's first-page route. A
  published `page` with id N keeps `/page/N` (it wins over the front page's page N).
  The author page (#350) pages the same way (`/author/{username}/page/N/`); term (#348)
  and search (#145) lists reuse these too.
- **Navigation menus (#347):** Appearance › Menus (`pages/Menus.tsx`, `/menus`, editors
  and admins) edits a local tree and saves it whole; every change (drag and drop, and the
  row's Move menu, its keyboard alternative) goes through `lib/menuTree.ts`'s
  `menuTreeReducer` (tested). Locations come from the active theme's
  `config.menu_locations`. The public theme gets menus from `src/lib/menus.ts` (`getMenu`,
  2s timeout, `null` on 404/failure; `normalizeMenu` re-checks every href), fetched in
  `base.astro` for `primary` and `footer` (the 500 page skips them). The default theme's
  rules are in `themes/default/README.md` (Menus).
- **Author pages (#350):** `/author/{username}` (`src/pages/author/[username].astro`, the
  theme's `layouts/author`, data from `src/lib/authorPage.ts`). The API's `/public/authors`
  routes return only `AuthorProfile` (name, username, avatar, bio, website) and 404 anyone
  not credited (`user_posts`) on a published post of a public type, the same 404 as an
  unknown username. The post route fetches `/public/posts/:id/authors` for the byline and
  the "Written by" cards; credited names link to their pages, an owner shown as a fallback
  doesn't. Avatar colours are keyed by username. The sitemap lists author pages last. Bio
  and website are edited on Profile (`lib/profile.ts` mirrors the API's checks).
- The admin Content list route `/content/:typeName` keys its component by `typeName`
  (`ContentByType` in `app.tsx`) so switching post types remounts + refetches.

## TipTap version pin (#193)

Known-good set, last reviewed 2026-10 (web test suite + two-user collab test):

- **Every `@tiptap/*` package is pinned exact (no `^`/`~`) to `3.4.2`.** TipTap expects
  all its packages on one version, and its packages depend on each other with caret
  ranges, so the transitive ones that StarterKit and friends pull in (`@tiptap/extensions`,
  `@tiptap/extension-list`, the StarterKit children, …) are forced to the same version
  by the **`overrides` block in `package.json`**. Without it, `npm install` resolves them
  to the newest 3.x, whose exact peer ranges then conflict with the pinned `@tiptap/pm`
  (ERESOLVE). `@tiptap/core` is imported directly, so it's a declared dependency and its
  override is `"$@tiptap/core"`.
- **`src/tiptapPin.test.ts`** fails if any `@tiptap/*` entry in `package-lock.json`
  resolves to a version other than the declared `@tiptap/core` — e.g. a new transitive
  package a bump added but `overrides` doesn't list.
- One exception on its own release line (no `3.4.2` exists): `@tiptap/y-tiptap` `3.0.0`.
- `prosemirror-utils` `1.2.2` is pinned exact too, and `y-protocols` `1.0.7` (rule 8;
  Hocuspocus and y-tiptap depend on it, keep one deduped copy).
- `@hocuspocus/server` / `@hocuspocus/provider` `3.4.4` and `paseto` `3.1.4` are pinned
  exact for the collab server in `collab-server/` (#206; read its `CLAUDE.md`). It is
  bundled with esbuild (`npm run build:collab`) and tested as its own vitest project
  (`npx vitest run --project collab-server`, plain Node).

### Upgrading TipTap

Upgrades are a deliberate, standalone PR — never part of an unrelated change.

1. **Bump all `@tiptap/*` packages together** with `node scripts/bump-tiptap.mjs <ver>`
   (from `web/`): it sets every direct `@tiptap/*` dependency and literal override to
   `<ver>`. If `tiptapPin.test.ts` then fails, a bump added a transitive `@tiptap/*`
   package: add it to `overrides` and re-run. Re-check whether `y-tiptap` needs a bump (its peer range on
   `@tiptap/core`/`@tiptap/pm`).
2. **Regenerate the lockfile in the web container** (`docker compose -f
   compose.dev.yaml exec -T web npm install`; local `node_modules` is incomplete on
   Windows), then confirm the lockfile diff is only `@tiptap/*` packages and that every
   `node_modules/@tiptap/*` entry resolves to the new version.
3. **Read the TipTap v3 changelog/release notes** for every version skipped, looking
   for: schema/node attribute changes (they change the ProseMirror JSON that flows into
   `blockBridge.ts` and stored `block_doc`s), `setContent`/command option changes
   (v3 takes `{ emitUpdate }`, not a boolean), Collaboration / `y-tiptap` changes
   (`isChangeOrigin`, sync plugin meta, undo/redo — StarterKit's `undoRedo` must stay
   disabled when collaborating), and drag-handle/node-range changes (block reordering).
4. **Run the web test suite**: `docker compose -f compose.dev.yaml exec -T web npx
   vitest run` (blockBridge round-trips, BlockId, the collab tests).
5. **Manual editor pass**: create, edit, save and reload every block type; drag a block
   to reorder; slash menu, bubble menu, character count.
6. **Two-user collab test**: log in as two users in separate browser contexts on the
   same post; type in both and check both see each other's edits and cursors; reload
   both and confirm nothing was lost or duplicated; publish and check the public page.
   Watch the collab container logs (from the top) for errors while doing it.
7. **Never change `yjs` / `y-protocols` / `@hocuspocus/*` as a side effect of a TipTap
   bump** (rule 8 in `gl-admin/lib/collaboration/CLAUDE.md`). If a new `y-tiptap` needs a
   newer `yjs`, bump it deliberately, check `npm ls yjs y-protocols` shows one copy each,
   and run the collab server's process test (single instance).
8. **Re-copy TipTap's base stylesheet** into
   `gl-admin/assets/styles/components/editor/_tiptap-base.scss` from the new
   `@tiptap/core` (`src/style.ts`, or the `var style =` string in `dist/index.js`). The
   editor runs with `injectCSS: false` because a destroyed editor removes TipTap's shared
   `<style>` tag (#305), so nothing else picks up changes to it.
9. Update the version and review date at the top of this section.
</content>
