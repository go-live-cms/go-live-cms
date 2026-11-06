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
- **Server-side logging is `src/lib/log.ts`** (#378), never `console.*` in SSR code (`src/pages`,
  `src/lib`, `src/middleware`, theme layouts and `functions.ts`): `log.warn("menu_fetch_failed",
  { location, error })` writes one JSON line `{time, level, msg, request_id, route, …}`, the error
  flattened into `error`/`error_type`/`status`/`cause`/`stack`. `msg` is a fixed snake_case name;
  the API's no-secrets rules apply (no headers, cookies, tokens, raw paths or query strings: use
  `safeUrl`; queries in any URL text and credential-named fields are scrubbed as a backstop).
  `debug` is dev only. The middleware runs each request in `runWithLogContext`
  (`src/middleware/requestContext.ts`, AsyncLocalStorage), so every line carries Caddy's
  `X-Request-ID` (also `Astro.locals.requestId`) and `context.routePattern` without passing them.
  Every SSR fetch to the API spreads `requestIdHeaders()` into its headers (the proxy sets it
  too), so the API logs the call under the same id; add it to any new one.
  `log.ts` has no Node imports and logs to the console in a browser, so shared code (block
  registry, `BlockRenderer`) may use it. Browser-only admin code and the collab server
  (`logEvent`) don't. Tests spy on it: `vi.spyOn(log, "warn")`. The production image starts
  with `server/start.mjs`, which wraps any other console output (Astro's banner and uncaught
  page errors, dependencies) as `{msg: "console", text}` lines; the scrub rules and the
  context hook both use are in `server/logFormat.mjs` (plain JS, no Node imports).
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
- **Theme blocks are build-time too** (#376): a theme's custom block is a directory
  `themes/<slug>/blocks/<Name>/` with `index.ts` (headless: `defineThemeBlock` from
  `gl-admin/lib/theme-blocks/define.ts`, the Block Spec and TipTap node; no React),
  `editor.ts` (`themeBlockEditor`: node view + slash entry, admin only) and `render.tsx`
  (the public renderer). Type = `theme:<slug>/<block>`. They're not listed in
  `theme.config.ts`. The admin, the SSR renderer and the collab bundle glob them; the API
  validates them from `themes/blocks.manifest.json`, generated by `npm run
  themes:manifest` and committed (`npm run build` and `themeBlocks.loadable.test.ts` fail
  on a stale one). **Adding or changing a theme block means regenerating the manifest and
  rebuilding the web, collab and api images.** Every installed block works whichever
  theme is active; only the slash menu follows the active theme. Contract:
  `themes/README.md` ("Custom Blocks"); collab rules: `gl-admin/lib/collaboration/CLAUDE.md`.
- **The public site never reads `/api/v1/posts*` or `/api/v1/media*` (#393):** they need a
  sign-in (the admin's working copy, drafts included). Posts come from `/public` only
  (`getPublicPost`, `getPublishedPosts`, `getPublicPostsPage` in `src/lib/api.ts`, which has
  no working-copy helpers any more), and so does the theme API client's `getPosts`/`getPost`.
  A with_meta row whose featured image is a pre-#201 filesystem path shows no image.
  Contributors list their own posts and published ones; the admin sends its token on every
  call (`apiCall`, `authenticatedFetch`, `blockAPI.ts`).
- **Published settings (#358):** the public site never reads `/api/v1/posts*` for a post's
  title, excerpt, featured image or terms: those are the working copy (the admin's). The post
  route reads `getPublicPost` (`/public/posts/:id` or `/slug/:slug`: the published post,
  featured image and terms in one call); RSS, the sitemap and the "latest posts" lists read
  `getPublishedPosts(type, …)` (`/public/posts`); the other `/public` lists already answer with
  published settings. On a published post a settings edit reaches the site on Update; the
  slug changes at once. The editor shows "settings go live on Update" from
  `GET /posts/:id/settings`, and restoring a version restores its settings too
  (`blockAPI.restoreVersionSettings`).
- **Changes not published (#326):** a published post whose body or settings differ from the
  live ones (the API's `has_unpublished_changes`; `api/CLAUDE.md`). `PostStatusPill` takes
  `unpublishedChanges` (accent pill, `UNPUBLISHED_CHANGES_LABEL`); the posts list and Pages
  tree show it, editors get a "Changes not published" tab (`status=published` +
  `unpublished_changes=true`, count from `/posts/counts`' `unpublished_changes`), and editors'
  Home counts them (linking to that tab, which contributors don't have). In the editor `PostForm` reads `blocks_changed`/`changed` from `GET /posts/:id/settings`
  on open, after settings saves, publish and restore, and on `Editor`'s `onStored` (the collab
  server's `stored` with `block_doc: "written"`, anyone's edits; debounced), so the top bar's
  pill and "Saved · changes go live on Update" follow collaborators live.
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
- **Post SEO (#357):** the post route builds the head from `getPublicPost`'s `seo` (the
  *published* values, never the admin's): `<title>` = `pageTitle(SEO title or title, site
  name)` ("X · Site"; the home page is `homeTitle`, site · tagline), description =
  `postDescription` (SEO description → excerpt → first paragraph, cut before 160),
  canonical = `postCanonical`, `og:image`/`twitter:image` from the API's resolved image (the
  1200 x 630 `social` variant) with width/height/alt, `hideFromSearch` → `robots` noindex
  (canonical and OG stay), and an Article JSON-LD (`articleJsonLd`, `jsonLdText`). The
  sitemap skips `/public/posts` rows with `noindex`; RSS, archives and search keep them.
  The excerpt is optional: lists use `postExcerpt` (the first paragraph without one).
  Admin: the settings panel's SEO tab is `components/editor/ui/PostSeoPanel.tsx`, rules in
  `lib/postSeo.ts` (tested); `PostForm` saves it debounced through `updatePostSEO` (and
  before Update), editors and admins only. Media `variants.social` is that crop; srcsets
  never include it.
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
  (the working byline, `user_posts`; the `/public` lists carry the published one, #319). Hierarchical types render `pages/Pages.tsx`, which loads every page for
  the tree. Features without a backend yet stay hidden (comments at the top of each page).
  The row menu's **Duplicate** (#354, any content role) calls `POST /posts/:id/duplicate`
  and opens the copy in the editor with the toast `DUPLICATED_MESSAGE`.
- **Post templates (#322):** Home's **New post** ("Blank or from a template") opens
  `components/content/NewPostDialog.tsx`: Blank goes to `/content/post/new` as before, a
  template calls `POST /post-templates/:id/posts` and opens the new draft. The lists' New
  button (Posts, Pages, any type) opens it too when the type has templates
  (`useNewPostChooser`), else goes straight to a blank post. The chooser **is** the
  templates manager: admins and editors rename (in place) and delete (asks first) from
  each template's menu; contributors only use them. Templates are saved from the row
  menu's **Save as template…** (moderators, not in the trash; `rowActions`' `template`),
  `SaveTemplateDialog`: a name (the post's title by default) and "Also save its category
  and featured image". Rules and wording: `lib/postTemplates.ts` (tested, limits checked
  against the Go); client: `lib/api/postTemplates.ts`.
- **Editor chrome (#341):** `components/editor/ui/EditorTopBar.tsx` (breadcrumb, status,
  save/connection state, presence, publish menu), `PostSidebar` (Post · History), History
  preview in the canvas (`RevisionsPanel`'s `VersionPreview`; the bound editor stays mounted,
  only hidden). Connection states and the unload warning are `utils/connectionState.ts`
  (tested): no change for `RECONNECT_GRACE_MS`, then "reconnecting", then offline; the tab
  warns on unload while the provider has unsynced changes or the connection is down. Editor
  styles use the design tokens only (never `prefers-color-scheme`). Features in the design
  without a backend stay hidden (comments at the top of each file; table on #341).
- **Block menu, jump to cursor, offline count (#356):** the drag handle is a button that
  opens `components/editor/ui/BlockMenu.tsx` (a portal: the drag-handle plugin moves the
  handle into the editor DOM): Colour ›, Duplicate (Ctrl D), Copy link to block, Move to
  (Ctrl Shift P, `MoveToDialog.tsx`), Delete. The actions are `utils/blockActions.ts` (one
  transaction each, blocks found by id, ids never copied); rules in
  `gl-admin/lib/collaboration/CLAUDE.md`. Colour is a palette token (`BLOCK_COLORS`), never
  a free colour: the admin styles it from `--block-*` (`_tokens.scss`), every public theme
  from its own `--block-*` as `.gl-color-<value>` (`themes/README.md`). Copy link copies the
  public URL + `#b-<block id>`, the id `BlockRenderer` puts on every top-level block. The top
  bar's collaborator avatars are buttons (Tooltip "Editing · Click to jump to cursor") that
  scroll to their caret, and offline it says "Offline · N edits waiting" (the provider's
  `unsyncedChanges`).
- **Block catalog and menus (#415, design `docs/design/block-library.md` 3.1–3.2):** every
  insertable block is one entry in `components/editor/blocks/catalog.ts` (`id`, Block Spec
  `type`, `name`, `group` text/media/layout/embeds/advanced, `keywords`, `markdown`, `icon`,
  `roles`, `insert(editor, range)`, optional `turnInto`; the header comment shows how to add
  one). Core blocks are `CORE_BLOCKS`; installed theme blocks come from their
  `themeBlockEditor(...).entry` (`group`, `keywords` options), offered only while their theme
  is active (`setActiveTheme`, set by `ThemeProvider`). `menuEntries({ role, theme, accepts })`
  is what a menu offers: `advanced` entries (and any with `roles`) are admins only, with the
  "Admins" pill (a UI hint; Custom HTML is enforced by the server, #428), and `accepts` is the
  hook for a container slot's nesting table (#414). `searchCatalog` matches the start of a
  word of the name (bold) or the start of a keyword (shown on the right), groups in the
  design's order, no cap. Readers: the slash menu (`ui/SlashCommand.tsx`: `/` at the start
  of a line, not in code or a caption; the text keeps focus and points at the listbox with
  `aria-activedescendant`; Esc closes and keeps the text), the gutter's **+**
  (`ui/AddBlockMenu.tsx`, its own search field; inserts into the line when it's empty, else
  on a new line below, `utils/blockGutter.ts`; Esc returns focus to +; Tab in the text
  reaches + then the drag handle), both through `ui/InsertMenu.tsx`, plus Turn into and the
  block-type toolbar (`utils/turnInto.ts`: values are catalog ids). The Markdown hints are
  StarterKit's/CodeBlock's own input rules, gated by the setting
  (`catalog.markdown.test.ts` types each one, on and off). The empty-line hint ("Type / for
  blocks", "…, or start writing" in an empty post) shows on the focused line only.
- **History "Highlight changes" (#355):** the History panel's switch (`lib/history/highlightChanges.ts`,
  in memory only: rule 0 rules out sessionStorage too, it survives a reload; on by default)
  makes `VersionPreview` compare the version with the working copy **as the collab server
  last stored it** (`GET /posts/:id/blocks`, plus `GET /posts/:id/settings` for the title and
  settings), re-read when `Editor`'s `onStored` fires (`workingKey`). It never reads the live
  editor or the Yjs doc, and writes nothing; Restore is unchanged (rule 9). The diff is
  `lib/history/blockDiff.ts` (blocks by id, moves = outside the LIS of kept order, list items
  and nested lists by their ids, attrs compared on their own, theme blocks' declared attrs)
  over `wordDiff.ts` (word tokens with marks, capped Myers); both pure. It runs in
  `blockDiff.worker.ts` (Vite's `new Worker(new URL(...))`, a same-origin file; the admin CSP
  has `worker-src 'self'`), else on the main thread in 8 ms slices (`diffClient.ts`).
  Rendering is `components/editor/ui/VersionDiff.tsx`: one-side blocks get a label and icon,
  changed text `<ins>` (underlined) / `<del>` (struck), unchanged blocks `--text-secondary`.
  `blockDiff.perf.test.ts` bundles the real worker with esbuild and runs 2,000 blocks in a
  Node worker thread.
- **Workspace screens (#343):** Users, Taxonomies, Settings, Themes, Profile and the new
  Post types page (`/post-types`, admin only) share `assets/styles/pages/workspace.scss`
  (header, list + side panel, field grids). Their rules live in `lib/settingsForm.ts`
  (dirty fields and the unsaved-changes bar's message), `lib/postTypes.ts` (PUT resets
  missing booleans and clears an empty description, so the form sends every field; Posts
  and Pages are built in and read-only), `lib/roles.ts` (`ROLE_DESCRIPTIONS` for the
  invite dialog) and `lib/profile.ts` (`newPasswordChecklist`: #344's `passwordRule`, the
  API's minimum, "Not your email or name", and "different from the current one"). `Input` masks
  refuse characters such as `! & : ?`; pass `unmasked` for free text the API validates.
  Saving a post type fires `POST_TYPES_CHANGED` so the sidebar reloads its menu.
- **Users screen (#333):** search (debounced, `GET /users?q=`: name, username or email), the
  Posts owned and Last active columns, and the row menu: Change role (also the role cell's
  button; `ChangeRoleModal`, `PUT /users/:id/role`) and Remove (`RemoveMemberModal`: who
  receives their posts and media, you by default; `DELETE /users/:id {transfer_to_id}`).
  Rules and messages are `lib/members.ts` (tested): "Now" within the API's 5-minute write
  interval, then `formatLastEdited`; no Remove on your own row; the API's `last_admin`,
  `cannot_remove_self` and `invalid_transfer_target` codes. Changing your own role refreshes
  `authManager`'s user.
- **Media library and detail (#342):** `/media` (grid, side panel for `?file=id`, at
  ≤768px a Drawer) and `/media/:id` (focal point with crop previews, Replace, fields,
  "Used in"). The rules (kinds, tags, filters, "Used in" rows, object-position) live in
  `lib/mediaLibrary.ts` (tested). "Used in" is `GET /media/:id/posts`, i.e. `post_media`:
  one row per post with `usages` (#176: `featured`, `block` with `block_id`/`block_type`,
  or `attached`), labelled by `usageLabels` ("Featured image and 2 image blocks"). Write
  access is `canWriteMedia` (`lib/roles.ts`). **Paste to upload (#28):** Ctrl/Cmd+V on the
  library uploads the clipboard's images through the same `upload` as the button and drop
  (`lib/mediaPaste.ts`, tested): ignored in text fields and dialogs, other clipboard
  content ignored. Copied files keep their names; the clipboard's unnamed picture (or
  Chrome/Firefox's generic `image.png`) is uploaded once, in its first format, as
  `pasted-YYYYMMDD-HHMMSS.<ext>`.
- **Missing alt text (#325):** alt is optional on upload (the admin no longer sends the
  file's stem) and an image may be marked **decorative** (`media.decorative`). Missing =
  an image (SVG too), not decorative, alt empty or only whitespace: `missingAlt` in
  `lib/mediaLibrary.ts`, the same rule as the API's `GET /media?missing_alt=true`. Tiles and
  the editor's image picker (`FeaturedImageSelector`, UI only) show "No alt text"; the
  library's filter is `?alt=missing`. `AltTextField` (panel and detail page) holds the alt
  text and "Decorative image"; an empty alt saves as empty (name and description still
  can't be cleared). The public `ImageBlock` renders `alt=""` when `doc.media[id].decorative`.
  Home reads the count through `GET /home/needs-attention` (#324).
- **Home's feeds (#324):** "Continue where you left off" is `getContinueEditing` (the posts
  you last worked on, from the API's activity log: "Edited 2 hours ago" is when *you* did),
  "Needs attention" is `getNeedsAttention` (failed scheduled publishes; for editors, images
  without alt text, posts with unpublished changes and review requests, #323) and
  "Activity" is `getActivity` (8 a page, "Show more"), all in `lib/api/activity.ts`. How an
  event or item reads is `lib/activityFeed.ts` (`describeActivity`, `attentionItems`, tested):
  current names and titles from the API, "You" for yourself, "Someone" without an actor, an
  unknown verb shown as is. Needs attention and Activity load and fail on their own. Presence
  on the recent cards (who's editing now) is still hidden.
- **Account pages (#344):** `/login`, `/forgot-password`, `/reset-password` and
  `/accept-invite` are Astro pages (no React) on `src/layouts/AccountPage.astro`, styled by
  `pages/login.scss` with the #338 class names (`gl-input`, `gl-button`, `gl-notice`,
  `gl-avatar`). Each page's `<script>` only calls a mount function in
  `lib/accountPages.ts` or `lib/loginPage.ts` (admin CSP: no inline scripts); the
  shared pieces are `components/account/`. The password minimum is `PASSWORD_MIN` in
  `lib/passwordRules.ts` (import-free, so pages render the hint server-side);
  `passwordRules.test.ts` fails if the API's `MinPasswordLength` (12, #329) differs or a
  password binding stops using `new_password`. `passwordMatchesDetails` mirrors the API's
  "not your email, username or name" check; forms pass the details they know (the reset
  page knows none, so there only the API checks). The invite preview returns
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
  not credited in the **published** byline (#319) of a published post of a public type, the same 404 as an
  unknown username. The post route fetches `/public/posts/:id/authors` for the byline and
  the "Written by" cards; credited names link to their pages, an owner shown as a fallback
  doesn't. Avatar colours are keyed by username. The sitemap lists author pages last. Bio
  and website are edited on Profile (`lib/profile.ts` mirrors the API's checks).
- **Term archives (#348):** `/{taxonomy}/{slug}` (`/category/guides`, page N
  `/category/guides/page/N/`). The URL is `[post_type]/[id].astro`: a public post type keeps
  it; otherwise, if a public taxonomy has the name (`isTermRoute`, `src/lib/termPage.ts`), it
  sets `Astro.locals.termArchive` and rewrites to `src/pages/term.archive.astro` (404 when
  reached directly; a dot can't be in a post type name). `[post_type]/[id]/page/[n].astro`
  does the same for page N. The page renders the theme's `layouts/term` from
  `loadTermPage`. The post route attaches `href` + `taxonomy_label` to each term of a public
  taxonomy (`linkTerms`), which the default theme's eyebrow, chips and sidebar
  "All <category> →" use. The sitemap lists term pages before authors.
- **Search (#145):** `/search?q=&type=` (`src/pages/search/`, the theme's `layouts/search`,
  data from `src/lib/search.ts`) over the API's `/public/search`; page N is
  `/search/page/N/?q=` (the pager's `query` prop keeps the query). The highlights are the
  only `set:html`, re-checked by `safeHighlight` (only `<mark>` survives); the query is only
  rendered as text. `noindex` (meta + `NOINDEX_PREFIXES`), never in the sitemap. The header
  link, phone menu field and 404 form are the theme's `SearchForm` (plain GET). The admin
  posts list's box (`?q=`) calls `GET /posts/search` with the tab's filters, best match first.
- **Site settings (#330):** `src/lib/siteSettings.ts` `getSiteSettings(Astro.locals)` fetches
  `/settings` once per request (pass `Astro.locals`; every caller shares it): title, tagline,
  language, time zone, date format. `<html lang>` is the language; the tagline is the home dek,
  the footer line and `SeoHead`'s fallback description (`og:site_name` = the site title).
  **Every public date goes through `formatSiteDate(date, site, "long" | "short")`**
  (`src/lib/siteDates.ts`): the preset sets the day/month/year order, the language the names,
  the time zone the day; never `toLocaleDateString` in a theme. The language list and presets
  mirror `api/settings_utils.go` (`siteDates.test.ts`/`settingsForm.test.ts` read the Go and
  fail on drift). Settings › General/Editor (`pages/Settings.tsx`, `lib/settingsForm.ts`) show
  the site address read-only (`site_address` = `PUBLIC_BASE_URL`; "Change domain" links the
  runbook). **Markdown shortcuts** = TipTap `enableInputRules`/`enablePasteRules` only
  (`lib/editorSettings.ts`: off keeps `typography` and `link`), read when the editor is created
  (`LiveGate` waits for the setting before mounting; connecting doesn't); never a `useEditor`
  dependency, so a change never recreates a bound editor. "Allowed embeds" stays hidden until
  #352 (the API stores and checks `editor_allowed_embeds`).
- **Scheduled publishing (#147):** the Publish menu's Schedule… / Reschedule… / Cancel schedule
  and the sidebar's Publish date open `components/editor/ui/ScheduleDialog.tsx` (owned by
  `PostForm`); a scheduled post shows a banner (Reschedule, Cancel schedule) or, after a failed
  attempt, "Scheduled publish failed" (`schedule_failure`), and polls `GET /posts/:id` once its
  time has come. Times are picked and shown in the **site's** zone (`lib/schedule.ts`: `zonedToUtc`
  mirrors the API's `siteLocalToUTC`, DST gaps refused; pills "Scheduled · Nov 3"); the dialog
  sends the wall-clock time as `local`. `PostStatus` takes `publishAt` and reads the zone through
  `useSiteDateSettings` (one cached `/settings` load; Settings resets it on save). The list's
  Scheduled tab and "All" (`draft,published,scheduled`) are in `lib/contentList.ts`; a
  contributor's own scheduled post is view-only (`canEditPost`, as the API).
- **Scheduled updates (#335):** a published post's Update menu has Schedule update… (enabled with
  changes not published) / Reschedule update… and Cancel update; they open the same `ScheduleDialog`
  with `mode="update"` (title "Schedule update", "The live post stays as it is until then", and the
  note `SCHEDULED_UPDATE_NOTE`: the content is frozen now, later changes aren't included).
  `PostForm` saves pending settings and waits for `EditorRef.whenAcknowledged()` (this tab's edits on
  the collab server) before `scheduleUpdate`, shows the notice "Update scheduled for Nov 3, 09:00"
  (Reschedule, Cancel update) or "Scheduled update failed" (`scheduled_update.failure`), and polls
  `GET /posts/:id` after `update_at`. The top bar's button reads "Update now"; Update by hand and
  Unpublish end it (the API's trigger). `PostStatus`/`PostStatusPill` take `updateAt` ("Update
  scheduled · Nov 3", info tone, over "Changes not published"); the posts list, Pages and Home pass
  the rows' `update_at`. Labels and the API's codes are in `lib/schedule.ts`.
- **Byline authors (#319):** the post settings' Authors field is
  `components/editor/ui/PostAuthors.tsx` (rules in `lib/postAuthors.ts`, tested): chips in credit
  order, each with a menu (Move earlier / later, Remove; the last author stays), and **+** opens a
  `Combobox` searching `GET /posts/author-candidates` (`onQueryChange`, server-side search).
  Every change saves the whole byline with the byline it was made to (`setPostAuthors`, `PUT
  /posts/:id/authors` + `base_author_ids`; a 409 = `BylineChangedError`: someone else's byline is
  shown instead, nothing overwritten), returns focus to the add button, and calls
  `onSettingsSaved`, so a published post shows "Settings changed" until Update. It's read-only
  with the other details (`canEditPostDetails`). The byline is not the owner: crediting someone
  gives no access. The public site gets the published byline from every `/public` read, so the
  theme's `PostByline`/`AuthorCards` need nothing else.
- **Post owner and Transfer (#353):** the post settings' Owner field
  (`components/editor/ui/PostOwner.tsx`, `GET /posts/:id/owner`: "Luan (you)", Transfer for
  admins, `canTransferPost`) opens `TransferOwnerModal`: the shared
  `components/users/MemberPicker.tsx` (the remove dialog's picker too, #333; `memberOptions`
  in `lib/members.ts`), only members with a content role (`canOwnPosts`), never the current
  owner, "Also replace me in the byline", and the confirm line ("Ana Costa will own this post.
  You keep your place in the byline."). Rules and messages: `lib/postOwner.ts` (tested).
  After it the Authors field reloads if the byline changed (a published post then shows
  "Settings changed"), and `PostForm` updates the owner its access rules read; the collab
  server's re-check makes a contributor who lost the post read-only.
- **Posts list filters, bulk actions and trash (#327):** Author / Category / Tag filters
  (`?author=` `?category=` `?tag=`, `FilterMenu`; options from `GET /posts/authors` and the
  `category` / `tag` terms) combine with the tabs, sort and search (`author_id`, `terms`).
  Table rows are selectable when the tab has bulk actions (`bulkActions`: publish + move to
  trash, contributors only trash; in Trash restore + delete permanently, which asks first);
  `POST /posts/bulk` answers per post and `BulkReportNotice` lists each one it refused and why
  (`bulkReport`), keeping those selected. The **Trash** tab (moderators: every trashed post;
  contributors: their own) shows "Trashed …", titles aren't links, and the row menu has only
  Restore / Delete permanently (`rowActions`; `roles.ts` `canTrashPost`, `canRestorePost`,
  `canDeletePostPermanently` mirror the API). The row menu's Delete is now **Move to trash**.
  Pages loads every status (`ALL_STATUSES`) so its tree has the Trash tab too. In the editor,
  a post moved to the trash while open closes with `post-trashed`: view-only with "This post was
  moved to the trash", no sign-in prompt. Still hidden: the byline bulk action (#319 landed after this; wiring it to `PUT
  /posts/:id/authors` is a follow-up), the design's bulk Archive, the Category column, the editor sidebar's Move to trash.
- **Profile account (#334):** the photo (`components/profile/AvatarPhotoModal.tsx`: pick, then the
  media `FocalPointPicker` sets where the API's square crop is centered, a round preview, "Save
  photo"; Remove), the email (`ChangeEmailModal.tsx`: new address + current password, a link to the
  new address; the page then says a link was sent and nothing else, since the API answers the same
  for a taken address) and "Other devices" (`GET /auth/sessions`' `other_count`, "Sign out of other
  devices"; no session list, the design has none). Rules and messages: `lib/profile.ts` (tested).
  Saving or removing the photo updates `authManager`'s user (sidebar, presence). **Avatars render
  only through `Avatar` / the theme's `avatarSrc`, which accept nothing but an API avatar path
  (`safeAvatarSrc` in `lib/presence.ts`)**: presence avatars come from other clients' awareness
  (`postCollab.ts` sends `avatar` with name/colour/id), which any collaborator can set. Presence
  colours stay the account's. `/confirm-email` is an account page (#344 patterns, CSP and noindex
  lists): it confirms only on the button (a mail scanner running scripts can't spend the token).
- **Review requests (#323):** `lib/api/reviewRequests.ts` (the API's routes) and `lib/reviewRequests.ts`
  (tested: what the editor's notice says and offers to whom, the row indicator, the API's codes).
  Anyone who can edit the post asks: the top bar's **Request review** button replaces Publish for
  those who can't publish, and is a "Request review…" entry in the Publish menu for those who can;
  both open `RequestReviewDialog` (`components/editor/ui/ReviewDialogs.tsx`: reviewer, "Any editor or
  admin" by default, and an optional note). `PostForm` reads `GET /posts/:id/review-request` on open,
  after a publish (which resolves it, the API's trigger) and when the tab is shown again, and renders
  `ReviewRequestNotice`: reviewers get Approve and publish/update (the Publish button's path; not on an
  archived post, which has no Publish),
  Request changes (`RequestChangesDialog`, a required plain-text note; comments #192 aren't built) and
  Dismiss; the requester Withdraw request; after changes are requested, the note (warning tone) and
  Request review again. The top bar shows a "Review requested" pill. The posts list's rows show
  `ReviewRequestedPill` under the path (who asked whom in its title/screen-reader text) and the Review
  filter (`?review=pending`, `ListFilters.review`); Home lists the requests ("Kenji asked for a
  review", `attentionItems`). The canvas draws only Home's item; the dialogs and notices use the #338
  components. Not on the Pages tree yet.
- **Front page and page templates (#336):** `/` (`src/pages/index.astro`) asks
  `getPublicFrontPage()` (`/public/front-page`): a page → rendered by
  `src/components/PostPage.astro` (the post route's render half, shared with
  `[post_type]/[id].astro`), canonical `/` (also at the page's own URL: `SiteSettings.frontPageId`),
  and `/page/N/` is a 404; a 404 → the latest posts as before; any other failure throws (never the
  list in its place). A page renders with its **published** template (`post.page_template` from
  `/public`) through `lib/themeLayout.ts` `pageLayoutVariant`: its `layouts/page/<name>.astro` if the
  active theme has it in this build, else the type's `layout_variants` variant if that's a page layout,
  else `default` (a theme switch never loses the stored name). Admin: Settings › General's **Front
  page** (`components/settings/FrontPageField.tsx`: latest posts or a published page; a saved one that
  was unpublished stays listed, with the warning; `toUpdateRequest` sends `front_page_id` only when it
  changed), the Pages list's **Front page** badge, **Template** column (moderators; with_meta rows
  don't carry it) and row menu **Set as front page** (admins, published pages); unpublishing,
  archiving or trashing the front page asks first (`FrontPageConfirm`, in `PostActions` and the
  editor's Publish menu). The page's **Template** field is `components/editor/ui/PageTemplateField.tsx`
  (saved at once, `PUT /posts/:id/template`; "Settings changed" until Update). Templates come from the
  API's theme scan (`usePageTemplates`, the active theme's `config.page_templates`). Rules and wording:
  `lib/frontPage.ts`, `lib/pageTemplates.ts` (tested).
- **Edit access requests (#321):** the editor's view-only notice (`components/editor/ui/
  PostEditAccess.tsx` `ViewOnlyNotice`) has **Request access** (a dialog, optional message ≤500)
  for a contributor watching someone else's published post, then "Request sent", or "declined,
  ask again after …"; reviewers (owner, editors, admins) get one notice per open request with
  Grant / Decline (`AccessRequestsNotice`) and the settings' "Edit access" list with Remove
  (`PostCollaborators`). All from `GET /posts/:id/access` (`lib/api/postAccess.ts`), which
  `PostForm` reads with the role before the editor mounts and again on every `onAccessChange`:
  a grant reaches the open editor as the collab re-check's `restored`, `PostForm` re-reads
  `collaborator`, and `canEditPost` (`lib/roles.ts`, mirroring `canEditWorkingCopy`) makes it
  editable without a reload; a revoke is `demoted`. Wording in `lib/postAccess.ts` (tested).
  Home's Needs attention lists `access_requests` ("Kenji asked for edit access", opening the
  post), and the Activity feed reads the `access_*` verbs with their `subject`.
- **Open signup (#191):** Settings › Accounts' "Allow anyone to sign up" (`allow_signup`, off by
  default). `/register` (the Accept-invite layout plus an email; the canvas has no sign-up board)
  and `/verify-email` (confirms on its button, like `/confirm-email`) are account pages (CSP and
  noindex lists); `mountRegisterPage`/`mountVerifyEmailPage` in `lib/accountPages.ts`. `/login`
  and `/register` read the setting server-side (`getSiteSettings(...).allowSignup`, false when
  unreadable): "Create an account" shows only while it's on, and `/register` renders just the
  "Sign-up is closed" panel otherwise. Success is one "Check your email" panel whatever the
  address (the API doesn't say), then `/login?reason=signup-confirmed`.
- **Nested blocks and the Group block (#414):** containers hold their blocks by id
  (`gl-admin/lib/blocks-spec/nesting.ts` is the table; rules in
  `gl-admin/lib/collaboration/CLAUDE.md`, "Containers"). Group: a Layout entry in the block
  catalog (`components/editor/blocks/catalog.ts`; the slash menu offers only what the slot
  the line is in accepts, `slotAcceptsAt`: no group inside a group, a list item or a quote), the node
  `extensions/GroupBlock.ts` (schema, commands) with its view in `BlockNodeViews.ts` (Width:
  Content/Wide/Full, Background: None/Tinted, shown while the cursor is in the group), the public
  `src/components/blocks/group/` (`div.group`, `is-tinted`, `alignwide`/`alignfull`) and the
  default theme's styles in `themes/default/styles/theme.css`. History's diff compares a
  container's children by id (`blockDiff.ts`, `VersionDiff`'s `version-diff__container`).
  Theme blocks may hold text only since then (`THEME_BLOCK_CONTENT_NAMES`).
- **Taxonomies and redirects (#331):** admin: one category per post. The editor sidebar's
  `PostTaxonomies` shows the `category` taxonomy as a radio group (picking one calls the PUT,
  which replaces the category; `post`-type posts have no "None", the API puts the default
  back; pass `postType`); other hierarchical types keep checkboxes. Taxonomies: categories
  nest one level (`termParentOptions`: top-level only, none for a category with children),
  the type's `default_term_id` gets a "Default" badge and no Delete (deleting another category
  moves its posts there), the slug shows its address prefix (`/` under the "category" URL
  structure, else `/{taxonomy}/`) and "Changing it updates N post URLs. Old links redirect."
  (the API adds the 301). Tags are selectable: a bulk bar ("2 selected", `aria-live` count),
  **Merge…** opens `components/taxonomies/MergeTagsPanel.tsx` (`POST
  /taxonomy/terms/:keep/merge`, the board's sentence) and Delete deletes them one by one after
  one confirmation (`DeleteTermModal` takes a list). Rules and wording: `lib/taxonomyAdmin.ts`
  (tested). Settings: a third URL structure "By category" (`URL_STRUCTURES` in
  `lib/settingsForm.ts`, checked against the Go binding) and **URLs & redirects**
  (`components/settings/RedirectsSection.tsx`, `lib/api/redirects.ts`, rules in
  `lib/redirects.ts`): outside the settings `<form>`, so it saves at once (never through the
  unsaved-changes bar) and Enter there adds a redirect; From/To checked like the API, 301/302,
  "External"/"302" badges, Created by with `Avatar`, delete asks first, Show more. The feed
  reads `terms_merged`, `redirect_created`, `redirect_deleted` generically.
  Public site: `postPath` (`src/lib/seo.ts`) takes the rows' `category_slug` (the
  **published** category on `/public` rows, the API's `golive_post_category_slug`) and gives
  `/{category}/{slug}` for posts of type `post` under the "category" structure (other types,
  and posts without a category or slug, as for slugs); lists, RSS, search, related posts and
  the sitemap follow it. `[post_type]/[id].astro` asks `src/lib/categoryUrls.ts` only when no
  public post type has the first segment and no public taxonomy does: `/{its category}/{slug}`
  renders the post, any other `/{x}/{post slug}` answers **301** to the post's URL (a renamed
  or changed category, a structure switch: no redirect rows needed for those). Redirect rows
  are answered by `src/middleware/redirects.ts` (`redirectOn404`, the last thing the middleware
  does): only a **404** for a GET/HEAD outside `/gl-admin`, `/api/`, `/uploads/`, `/themes/`
  asks `GET /public/redirects?path=`, so a redirect never hides a live page; 301 (cached an
  hour) or 302 (`no-cache`), the request's query kept for a site path. A failed lookup keeps
  the 404.
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
