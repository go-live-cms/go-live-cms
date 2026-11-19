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
- **Page `Cache-Control` (#185):** `src/lib/httpCache.ts`, applied by the middleware to every
  public HTML response without its own header: `public, max-age=60, stale-while-revalidate=300`
  only for a 200 from `CACHEABLE_PAGE_ROUTES` (home, post/page URLs, archives, term and author
  pages, their page N) to an anonymous visitor with `SITE_URL` set; `private, no-store` for the
  rest (a session cookie, a `Set-Cookie`, search, 404/500, unknown routes). A page that renders
  something per visitor must not be in that list. The API caches its public reads in Valkey and
  purges on every publish (`api/CLAUDE.md`); `/api/posts-reload` is just a no-cache passthrough.
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
- **Plugins (#455):** `plugins/<slug>/plugin.json` (`plugins/README.md`). `gl-admin/lib/plugins/manifest.ts`
  is the import-free twin of the API's validator; `pluginManifestVectors.json` is shared with the Go
  tests, and `manifest.test.ts` validates every plugin in the repository. Server hooks (#458) are Go in
  `plugins/<slug>/server/`, built into the API only (`api/CLAUDE.md`); the web build ignores them.
  A publish a plugin's guard refuses (#459) is a 409 `plugin_refused` whose `error` is the plugin's
  reason: `blockAPI` makes it the error's message (so list toasts show it), `pluginRefusalReason`
  (`lib/api/errors.ts`) puts it in the editor's "Publish failed" banner, the bulk report shows it,
  and the scheduled publish/update notices say a plugin stopped it (`lib/schedule.ts`).
  A plugin without Go code may deliver its hooks to a URL instead (`server.webhook`, #460: a URL
  setting and a secret setting, validated by both twins).
- **Plugins page (#11, #457; the canvas's "Plugins" board):** `pages/Plugins.tsx` at `/plugins`
  (admins: `AdminOnly` in `app.tsx`, Workspace › Plugins in `nav.ts`). One list (name, version,
  author, description, the status pill, declared capabilities plus "Can block publishing" for a
  `post.before_publish` hook), Enable (the trust warning and what it declares) and Disable (what
  it affects: blocks, server features, settings) behind dialogs, and Settings, a `Drawer` built
  from the manifest's fields (text, `enum` select, number, switch, secret: "Saved" + Replace,
  never the value) with **Delete plugin data** (asks first). Rules, wording and the form's draft
  (only changed fields are sent; a cleared number sends null; a secret only when one is typed)
  are `lib/pluginsPage.ts` (tested); the client is `lib/api/plugins.ts`, its own and admin-only
  (never `ThemeSettingsImpl`). The disable dialog of a plugin with blocks leads with "Used in N
  posts" (`getPluginUsage`, #456's `GET /plugins/:slug/usage`, read when it opens; a failed read
  leaves the number out). Hidden until their issues: upload/delete (installing is the image) and
  "Update to x.y" (#332). Home's feed reads the `plugin_*` verbs, linking here.
- **Plugin blocks (#456):** `plugins/<slug>/blocks/<Name>/` with `block.json` (data: the inputs of
  `defineThemeBlock`; `lib/plugins/blockJson.ts`, vectors shared with Go), `editor.ts`
  (`pluginBlockEditor`) and `render.tsx`. Globs: `lib/plugins/blocks.ts` (plugin.json + block.json,
  also bundled by collab), `lib/plugins/editorBlocks.ts`, `src/components/blocks/registry.ts`. The
  schema is theme blocks then plugin blocks, by type (`installedExtensionBlockNodes`), whatever is
  enabled; the menus offer an enabled plugin's blocks only (`setEnabledPlugins`, from `GET
  /plugins/enabled` through `ThemeProvider` → `lib/enabledPlugins.ts`, on load and on return to
  the tab; a failed read offers none). **On the page every plugin block renders inside
  `PluginBlockBoundary`**: a renderer that throws renders nothing, logged
  `plugin_block_render_failed` (plugin, type, block id, error). SSR has no React error boundaries,
  so the server renders the block on its own first through a probe (`react-dom/server`), registered
  by the middleware (`src/lib/pluginBlockProbe.ts`) to keep it out of the admin bundle; in a browser
  it's a class boundary. Theme and core blocks don't go through it. `reading-time` is the example.
- **`context.settings` (`src/lib/theme-settings.ts`, #451):** a theme's settings are rows keyed
  `theme:<slug>:<key>` in `extension_settings`, publicly readable, written with an admin's token.
  Never copy it for plugins, whose settings may be secret (`docs/design/plugin-system.md` section 6).
- **Theme blocks are build-time too** (#376): a theme's custom block is a directory
  `themes/<slug>/blocks/<Name>/` with `index.ts` (headless: `defineThemeBlock` from
  `gl-admin/lib/theme-blocks/define.ts`, the Block Spec and TipTap node; no React),
  `editor.ts` (`themeBlockEditor`: node view + slash entry, admin only) and `render.tsx`
  (the public renderer). Type = `theme:<slug>/<block>`; a plugin block (#452) is
  `plugin:<slug>/<block>`, treated the same everywhere (`isExtensionBlockType`). They're not listed in
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
  access is `canWriteMedia` (`lib/roles.ts`). **The site design (#496):** the same call
  (`getMediaUsedIn`) answers `site_templates` and `site_logo`; "Used in" lists "Site logo" and each
  template or part ("Header part", "… · Not published yet", another theme's as "Header part
  (classic theme)") first, named but not linked (`siteDesignUsedInRows`), and the delete
  confirmation (`DeleteMediaDialog`) looks the files up each time it opens
  (`lookUpSiteDesignNames`: four at a time, 8 s each) and names them in a status line
  (`deleteSiteDesignNotice`). Delete waits for the lookup; a failed or timed-out one says
  "Couldn't check whether the site design uses it." **Paste to upload (#28):** Ctrl/Cmd+V on the
  library uploads the clipboard's images through the same `upload` as the button and drop
  (`lib/mediaPaste.ts`, tested): ignored in text fields and dialogs, other clipboard
  content ignored. Copied files keep their names; the clipboard's unnamed picture (or
  Chrome/Firefox's generic `image.png`) is uploaded once, in its first format, as
  `pasted-YYYYMMDD-HHMMSS.<ext>`. **Add from URL (#29, the canvas's "Media · Add from URL"
  board):** beside Upload, a dialog (`components/media/AddFromURL.tsx`) with one link per line
  (≤ 10); the API's `POST /media/import` downloads each into the library like an upload (copy
  only, never a hotlink) and answers per link: added, or the API's reason; "Try failed again"
  puts the failed links back. The media picker shows the same form in place (it's already a
  dialog) and picks what was added, if it is of the picker's kind. Rules and wording:
  `lib/mediaImport.ts` (tested). Home's feed: "added hero from images.example.com".
- **Video captions (#507):** a video's detail page and side panel have **Captions (VTT)**
  (`components/media/CaptionsField.tsx`, rules `lib/mediaCaptions.ts`): the shared `MediaPicker` with
  the `captions` kind (`text/vtt`, the API's `type=captions`; also a library filter), Remove, and the
  language, each saved at once (`PUT /media/:id`). "Used in" of a captions file reads "Captions of a
  video block". The public video block renders the entry's `captions` as `<track kind="captions">`
  (`blockCaptionsFor`); the production `/uploads` proxy forces `text/vtt` + nosniff for `.vtt`.
- **Missing alt text (#325):** alt is optional on upload (the admin no longer sends the
  file's stem) and an image may be marked **decorative** (`media.decorative`). Missing =
  an image (SVG too), not decorative, alt empty or only whitespace: `missingAlt` in
  `lib/mediaLibrary.ts`, the same rule as the API's `GET /media?missing_alt=true`. Tiles and
  the shared media picker (`components/media/MediaPicker.tsx`, #423, UI only) show "No alt text"; the
  library's filter is `?alt=missing`. `AltTextField` (panel and detail page) holds the alt
  text and "Decorative image"; an empty alt saves as empty (name and description still
  can't be cleared). The public `ImageBlock` renders `alt=""` when `doc.media[id].decorative`; otherwise the
  block's alt, else the library's (`doc.media[id].alt`, #481), else no `alt` at all (`imageAlt`).
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
- **Reader comments' rules (#522, `src/lib/discussion.ts`, design
  `docs/design/reader-comments.md` 6.3, 12.4):** import-free twins of `api/discussion.go` and
  `api/discussion_text.go`: `discussionSetting` (clock-free `{state, closes_at}`) and
  `discussionState(setting, now)` for the editor's Discussion section and the renderer, and the
  text rules (`normalizeReaderCommentBody`, `readerCommentLength` in code points, as the API
  counts) for the form's counter. Pinned by `src/lib/discussionStateVectors.json` and
  `src/lib/discussionTextVectors.json` (both suites; `JSON.parse`). Nothing renders comments yet
  (C5 #525), and `comments_enabled` stays off, its switch hidden until #526 (#527, below). **The reads (#523):**
  `getPublicPost`/`getPublicFrontPage` carry `discussion` (`{state, closes_at, count}`, cached and
  clock-free: apply `discussionState(discussion, now)` before showing a form), and
  `getPublicPostComments(id, page)` / `getPublicCommentThread(id, rootId)` in `src/lib/api.ts` read
  the threads (null on a 404; types `PublicReaderComment`, `PublicReaderCommentThread`). #524 adds
  the word-list, link and member-name twins (`matchDiscussionWord`, `readerCommentLinks`,
  `matchesMemberName`, `src/lib/discussionRulesVectors.json`).
- **Comment write endpoints (#524, `src/lib/commentWrites.ts`, design 9.4):** the API's comment
  writes are under `/public` (never proxied), so the form posts to the site:
  `POST /gl-comments/posts/:id` (`src/pages/gl-comments/posts/[id].astro`), `/gl-comments/confirm`
  and `/gl-comments/unconfirmed/:id` (`.ts`, the confirm page's buttons; #525 builds the page).
  Each refuses a cross-origin request (`isSameOriginPost`), maps the form (`COMMENT_FORM_FIELDS`:
  `comment`, `name`, `email`, `notify_replies`, `website` = the honeypot, `parent_id`, `return_to`)
  to JSON, forwards the browser's address (`appendForwardedFor`, shared with the API proxy), the
  request id and the `gl_commenter` cookie's keys as `GoLive-Commenter-Key`. The cookie
  (`commenterSetCookie`): up to five keys, `.`-separated, **`Path=/gl-comments`** (no page request
  carries it, so pages stay cacheable), HttpOnly, SameSite=Lax, a year, Secure except in plain-HTTP
  dev; set only from a confirmation's `set_key`, which never reaches the page's script
  (`jsonAnswer` drops it). Without scripts: 303 back to `return_to` (else the API's `post_url`)
  with `?commented=confirm|pending|published#comment-form`, or the refusal page
  (`src/components/comments/CommentRefused.astro`: 422/429/503, the reason, the typed text in a
  read-only textarea, Back to the post); `Accept: application/json` gets the API's JSON. A
  refused confirmation without scripts goes to `/comments/confirm?error=<code>`. Everything is
  `private, no-store`; `httpCache.ts` `isPerReaderUrl` also makes any `?commented=` page and the
  reader pages no-store. `/gl-comments` is noindex and in robots.txt. Logs: route pattern and
  status only. Tests: `src/lib/commentWrites.test.ts`, `src/pages/gl-comments/confirm.test.ts` and
  the container test `src/pages/gl-comments/commentEndpoint.astro.test.ts` (the no-script flow).
- **Discussion settings screens (#527, design 12.1–12.3; the canvas's "Settings · Discussion", "Post types ·
  Posts" and "Discussion settings…" boards):** Settings › Discussion is its own page, `/settings/discussion`
  (`pages/SettingsDiscussion.tsx`, admins), after Editor in the Settings menu (`components/settings/SettingsNav.tsx`,
  shared with General, whose in-page links it keeps): Moderation, Display and Privacy (`PrivacyPageField`, the Front
  page's option rules), the General page's unsaved-changes bar, and Off shows the switch alone. Rules and wording:
  `lib/discussionSettings.ts` (tested); its checks (ranges, word lists, the notice) are the API's, pinned by
  `lib/discussionSettingsVectors.json` (Go runs it too), so the form refuses before any request; an unpredicted 400
  lands on its field (`apiFieldError`). **The site switch is hidden until the moderation queue ships**
  (`COMMENTS_SWITCH_READY = false`; #526 sets it true): until then the page shows a note in its place, and the
  switch only while the API already has comments on (to turn them off). Post types: Posts and Pages open in the
  panel with every field locked but **Comments** (`canChangeField`, `builtInSupports`,
  `updateBuiltInPostTypeSupports`: `supports` alone). The editor's **Discussion** section ends the Post tab
  (`components/editor/ui/PostDiscussion.tsx`, rules `lib/postDiscussion.ts`): Default · Open · Closed · Off
  (`ui/SegmentedControl.tsx`, native radios), what applies now from the shared rule ("Default · Open · closes on
  Dec 3"), a status line; it saves at once (`lib/api/postDiscussion.ts`, `PUT /posts/:id/discussion`) and never
  calls `onSettingsSaved`, so no "Changes not published". Editors and admins only (`PostSidebar`'s `discussion`,
  from `PostForm`; the API is `requireContentEditor`, decision 3). The counts linking to the queue wait for #526.
- **Global styles (#485, `src/lib/globalStyles.ts`, design `docs/design/theme-builder.md`
  section 6):** the override grammar, validator, contrast (`CONTRAST_PAIRS`, which the
  default theme's `tokens.test.ts` checks) and groups, the same rules as the API's
  `api/global_styles.go`, pinned by **`src/lib/globalStyleVectors.json`** (both test suites
  read it; read it with `JSON.parse`, not a JSON import, or `"__proto__"` becomes a
  prototype). `resolveThemeTokens` accepts per token only its kind (colour, length, line
  height) and resolves font ids through `config.fontOptions` then `SYSTEM_FONT_STACKS`.
  `themes/tokens.manifest.json` (declared tokens + font options per theme, for the API) is
  generated with the block manifest (`npm run themes:manifest`, `--check` in `build`;
  `installedThemeTokens.test.ts` fails on a stale one): regenerate it after changing a
  theme's tokens or `fontOptions`.
- **Design preview (#486, `src/lib/designPreview.ts`, design `docs/design/theme-builder.md`
  8.3):** `POST /gl-preview` (`src/pages/gl-preview.ts`, same-origin form posts only) takes a
  `token` from the API's `POST /site-design/preview` and sets `__Host-gl_design_preview`
  (HttpOnly, Secure, SameSite=Strict, Path=/, 15 min; `gl_design_preview` without Secure only in
  `astro dev` over plain HTTP), then 303s to `redirect` (a path on this site, else `/`); no token
  (the banner's Exit) clears it. The token is only ever in a form body and the cookie, never a URL
  or a log line. With the cookie, the middleware reads `GET /site-design/draft` (bearer) for public
  pages and, for the active theme, sets `locals.globalStyles` to the draft and
  `locals.designPreview`; a refused token (401/403/409) clears the cookie, an API that can't answer
  renders published. A previewed HTML page gets `private, no-store`, `X-Robots-Tag: noindex` and
  the banner right after `<body>` (core markup and fixed colours, the default theme canvas's
  board: a labelled region, Exit as a plain POST form, the first Tab stop). Any page asked for with
  the cookie is `no-store` (`httpCache.ts` counts it as a session cookie). The admin CSP has
  `frame-src 'self'` for the Site editor's frame; `gl-admin/lib/api/designPreview.ts`
  `openDesignPreview(target, path)` posts a fresh token into it (#487).
- **Publish site design (#492, `gl-admin/lib/api/siteDesign.ts`):** `publishSiteDesign({ confirmContrast })` is
  the one "Publish site design" call (styles, templates and parts of the active theme in one release; the styles
  screen and the Site editor both use it), plus the overview (`getSiteDesignOverview`: per item `change`, the
  Publish button's `unpublished_changes`), Reset / Keep editing / Delete, history (`listSiteDesignReleases`, versions)
  and the styles' REST restore and discard. Templates and parts restore through the editor only:
  `lib/collaboration/templateRestore.ts` (rule 9). The publish (#487's fetch with one 401 refresh) throws
  `ContrastUnconfirmedError` (`pairs`), `StylesChangedError` (`current`) and `DesignInvalidError` (`problems`:
  `template_empty`, `template_invalid`, `part_unresolved`); `design_changed`, `nothing_to_publish` and 503
  `collab_unavailable` (naming the item it couldn't flush) are ApiErrors with the server's message.
- **Site editor (#493, design `docs/design/theme-builder.md` 13; the redesign canvas's row 8):** `/site-editor` (the
  overview, `pages/SiteEditor.tsx`), `/site-editor/templates/:id` (the template and part editors,
  `pages/SiteTemplateEditor.tsx`), `/site-editor/history` (`pages/SiteDesignHistory.tsx`) and #487's
  `/site-editor/styles`, all `AdminOnly`; Appearance › Site editor (admins, `nav.ts`); Themes › Customize opens it
  (Layouts… keeps the layout-variant dialog). Rules and wording are `lib/siteDesign.ts` (tested): the overview's rows
  and "renders now" vocabulary, the row and More menus, new names (`savedTemplateName`, 13.1), the publish list and
  refusals, preview pages, "Used in". The editors are the post editor: `Editor` with `templateId`/`templateKind`
  (`template-<id>`, `acquirePostCollab(id, "template")`) and a `siteBridge` (`SiteEditorBridge`: the part card's state
  and button, `routeHasList` for the query loop). Custom HTML and footnotes are post-only (`contexts`), the Site group
  comes first, and Post content is offered once (`offeredOnce`). Restore, Discard and Start over go through
  `templateRestore.ts` with `EditorRef.getRestoreTarget()` (a reset item is read-only: Keep editing first). Publish is
  `components/site-editor/PublishDesignDialog.tsx` (the overview read on open; refusals, then contrast), shared with
  the styles screen, whose count now includes templates and parts. The preview frame (`StylesPreview` with the route's
  pages) reloads on the collab server's `stored`; a previewed request reads the **working copies** through
  `GET /site-design/draft?slugs=` (`readDraftSiteDesign`, the middleware's `locals.designPreview.readTemplates`).
- **Theme contract (#484, `themes/README.md` "The theme contract", design
  `docs/design/theme-builder.md` 3.5):** core emits tokens (`src/lib/themeTokens.ts`:
  `themeCssVariables(resolveThemeTokens(config, Astro.locals.globalStyles))`; the middleware
  sets `globalStyles` from `/themes/active`'s published `global_styles`, else
  `NO_GLOBAL_STYLES`; `supports.globalStyles`), scripts are
  `config.assets` with `blocking` for `<head>` (`src/lib/themeAssets.ts`,
  `components/ThemeScripts.astro`), `components/TemplatePart.astro` renders a published override part or its slot
  (#491), and nested `BlockRenderer`s share one page scope (`blocks/utils/pageScope.ts`: heading
  ids unique across docs, `/gl-embeds.js` once). **The default theme's HTML is pinned by
  `themes/default/theme.astro.test.ts`'s whole-page snapshots** (`__snapshots__/layouts/`);
  Astro whitespace is fragile (an expression or a component at the end of `<body>` adds or
  drops a space), so check them after any `base.astro` edit.
- **Site blocks I (#488, design `docs/design/theme-builder.md` 4):** site title, tagline, logo, navigation, search and
  template part, core Block Spec types (`gl-admin/lib/blocks-spec/siteBlocks.ts`, `siteBlockVectors.json` shared with
  Go). In the one schema, but offered only in templates and parts: catalog entries carry `contexts` (`SITE_BLOCKS`, the
  **Site** group; `menuEntries({ context })`, a post by default) and the editor's kind is `SiteBlockContext`
  (`getExtensions({ docKind })`, "post" until the Site editor, #493). No parse rules, so paste can't make one. Editor
  views are labelled placeholders (`SiteBlockViews.ts`; inert in a post, and they say so), the Block tab
  `ui/SiteBlockSettings.tsx`. **On the page they render only from a `SiteRenderContext`** (`src/components/blocks/
  utils/siteContext.ts`) passed as `BlockRenderer`'s `site` by a block template's layout (#491), which fills it before
  the synchronous render with `src/lib/siteRenderContext.ts` (`loadSiteRenderContext`: the request's settings, each
  navigation location's menu once, the parts and menus by id the resolve route attaches). Without one (a post's body)
  each renders nothing. Markup: `src/components/blocks/README.md`; default theme rules: the "site blocks (#488)"
  section of `themes/default/styles/theme.css` (`themes/default/siteBlocks.test.ts`). Collab rules:
  `gl-admin/lib/collaboration/CLAUDE.md`.
- **Site blocks II (#489, design `docs/design/theme-builder.md` 4.1–4.5):** the query loop (`query`, `post_template`,
  `query_pagination`, `query_no_results`), `query_title`, `term_description` and the `post_*` blocks, the same chain
  as #488's (renderers in `src/components/blocks/utils/postBlocks.tsx`, markup in `src/components/blocks/README.md`,
  the default theme's "site blocks II (#489)" section). `loadSiteRenderContext` (`src/lib/siteRenderContext.ts`) also
  takes the route (`SiteRoute`: its post, its own list, term, author or search) and fills each query's posts before
  the render: `collectTemplateNeeds` keeps **four per page**, parts counted (the rest render nothing, logged
  `site_block_query_limit` once); an inheriting query is the route's list (no fetch), any other one page of
  `/public/posts/type/:type` with its filters (`queryRequestParams`, 2 s, `readQueryPosts`); a failure renders that
  query nothing and is logged once per request (`site_block_data_failed`, the block type and a count). The pager is
  #349's (`pageLinks`, `pagePath`), only for an inheriting query. Bylines are core's (`src/lib/bylines.ts`), which the
  default theme re-exports.
- **Site blocks III (#497, design `docs/design/theme-builder.md` 4.5's "As built (T16)"):** `related_posts`,
  `author_cards`, `table_of_contents`, `color_scheme_switch` and `readingTime` on `post_byline`, the same chain
  (renderers in `src/components/blocks/utils/postEndBlocks.tsx`). Each renders **the markup of the default theme
  component it replaces** (`RelatedPosts`, `AuthorCards`, `TableOfContents`, `ThemeSwitch`;
  `themes/default/siteBlocksMarkup.astro.test.ts` compares them). Related posts are read before the render
  (`loadRelated`, `/public/posts/:id/related`) and count towards the page's four with the queries. The table of
  contents and `post_content` share `usePostContentHeadings` (the template's page scope, `TemplateScopeContext`
  from a part), so its links are the body's ids. The blocks' section ids (`toc-title`, …) are page-wide
  (`siteBlockTitleIds`, reserved by the outermost renderer). The switch has no script: `theme-init.js` drives it,
  and `:root:not([data-js]) .color-scheme-switch` hides it without one. Reading time and the byline's names
  are core's (`src/lib/readingTime.ts`, `src/lib/bylines.ts`), re-exported by the theme.
- **Template rendering (#491, design `docs/design/theme-builder.md` 3.2–3.4, 3.7):** every public route file makes one
  call, `resolveTemplate(Astro.locals, route)` (`src/lib/siteTemplates.ts`): the route's ranked slugs (`templateRanks`:
  `single-{type}`/`single-{variant}`/`single`, `page-{template}`/`page-{variant}`/`page` (#498: the type's
  `layout_variants`, no code layout of their own), `front-page` first at `/`, `archive-{type}`/`archive`,
  `taxonomy-{tax}`/`taxonomy`/`archive` (#498: `layouts/term` is `taxonomy`'s), `author`/`archive`, `search`, `404`;
  never the 500 page) go to
  `GET /public/site-templates/resolve?theme=&slugs=` (published only, cached, 2 s; memoized per request on
  `locals.siteTemplateResolves`). The builder template wins when its rank is the same as or more specific than the
  **active theme's** first code layout in the build (`codeLayoutRank`, glob keys only; the default theme's layouts are
  the last resort and never compared), and the route renders `src/layouts/BlockTemplateLayout.astro` with **the same
  props** plus `kind` and `choice`; else its code layout, as before. A failed resolve is the code layout
  (`site_template_resolve_failed`). The layout's head is what the theme's layout gives `SeoHead`
  (`lib/blockTemplateLayout.ts` `templateHead`, pinned by `BlockTemplateLayout.astro.test.ts`), its body the template in
  one `BlockRenderer` with `anchors={false}` and `frame="template"` (leading parts, `main#content.site-main`, trailing
  parts; parts and the template get no `b-<id>`, the post's blocks keep theirs). `<TemplatePart slug>` in a code layout
  renders a **published override** part (`templatePartOverride`, from the same resolve) and its slot otherwise. A
  previewed request reads published templates until #492 adds them to the draft read (`templateReaderFor` is the seam).
- **The default theme as block templates (#498, design `docs/design/theme-builder.md` 5.7's "As built (T17)"):**
  `themes/default/templates/*.json` (every route kind and the post/page variants, never `front-page` or the 500 page)
  and `parts/{header,footer}.json`, so every default-theme page renders through `BlockTemplateLayout` and "Customize"
  starts from what readers see; its `.astro` layouts stay as the fallback (a failed resolve, the 500 page). **Parity is
  tested:** `theme.astro.test.ts`'s "block templates (#498)" renders each template on #484's fixtures and compares it
  with that layout's snapshot (`__snapshots__/layouts/`) element by element after the listed differences
  (`themes/default/templateParity.ts` `BLOCK_TEMPLATE_DIFFERENCES`, also in the PR); the template's own page is pinned
  in `__snapshots__/templates/`. The CSS that lays the blocks out like the code layouts is theme.css's "block templates
  (#498)" section (by `.template-part--header|footer` and `[data-template]`). What it needed: **site blocks IV**
  (`src/components/blocks/utils/siteBlocksIV.tsx`, `themeMarkup.tsx`: the theme's `SearchForm`, `ThemeSwitch`,
  `PostByline` and pager markup), the theme contract's `assets.fonts` and `imageSizes` and a skip link in the generic
  layout. The files are also core's starters (`api/sitedesign/starters`, a copy: `go generate ./api/sitedesign`, and
  Go's `TestStartersAreTheDefaultThemes` fails on drift). Changing a template: edit the JSON, run `go generate`, check
  the parity test (and the snapshot under `templates/`).
- **Site logo (#488):** Settings › General's **Site logo** (`components/settings/SiteLogoField.tsx`, rules
  `lib/siteLogo.ts`): the media picker (images only), Replace and Remove, saved with the page as
  `site_logo_media_id` (sent only when it changed, like the front page). `GET /settings` answers it with `site_logo`
  (its media's public path, size, variants, alt), which `getSiteSettings(...).logo` reads for the Site logo block.- **Default public theme (#345):** tokens live in `themes/default/theme.config.ts` and
  become CSS custom properties in `base.astro` (core's `src/lib/themeTokens.ts`); `styles/theme.css` is plain
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
  table of contents passes its `headings` so both agree. The page title is the one `<h1>` (#481): a Heading 1
  block (or a missing or invalid level) renders as an `h2`, and `headingLevel` gives the TOC the same level;
  an embed's note id (`embedNoteId`) is never a heading's. Older/newer and related posts come
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
  language, time zone, date format. `<html lang>` is the language (the account pages and `layouts/Page.astro`
  read it with `getSiteLanguage`: at most 250 ms, then the last language read, else the default, #481); the tagline is the home dek,
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
  dependency, so a change never recreates a bound editor. **Allowed embeds** (#425) is the Editor
  section's list of checkboxes (`editor_allowed_embeds`; an id this build doesn't list is left out
  of the draft, or the API would refuse the save).
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
  (saved at once, `PUT /posts/:id/template`; "Settings changed" until Update). Templates come from
  `GET /posts/page-templates` (`usePageTemplates`: the theme scan's layouts plus the published Site editor
  page templates; one request shared by what mounts together, asked again on every mount, never caching an
  answer that started before `resetPageTemplates`; `usePageTemplates.test.tsx`). Rules and wording:
  `lib/frontPage.ts`, `lib/pageTemplates.ts` (tested).
- **Builder page templates (#494, design `docs/design/theme-builder.md` 10, the canvas's "Template field with
  builder templates" board):** the Template field lists the theme's layouts under "<Theme>’s layouts", then
  the `custom-<name>` templates the site would render (published overrides, and any the theme ships) under
  "Made in the Site editor", each tagged "Site editor" (headings
  only when there are builder templates: `Select` options take `group` and `tag`, rendered as `role="group"`
  runs and a `Pill`). A page stores `block:<name>`. One that isn't published any more stays listed and shown,
  with "Pricing isn’t published in Paper, so this page shows with Default. …" (`templateNote`); the Pages
  list's Template column shows the title with the tag, or the default with that note. On the site,
  `templateRanks` ranks `custom-<name>` then `page`, and `pageLayoutVariant` never matches a `block:` name, so
  an unpublished one renders the default and keeps the name (`BlockTemplateLayout.astro.test.ts`, "builder page
  templates (#494)").
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
- **Block comments (#192):** threads anchored by the block's `data-block-id`, kept by the API
  (`lib/api/comments.ts`; `api/CLAUDE.md`), never in the Yjs doc. `PostForm` owns one
  `PostCommentsStore` per open post (`lib/commentsStore.ts`, memory only): read on open, on the
  collab server's `{"type":"comments"}` nudge (`HocuspocusCollaboration.onComments`, which `Editor`
  wires with a refetch on every resync), when the tab is shown again, and from every write's answer
  (numbered, so an older read never undoes a write). In the editor `ui/BlockComments.tsx` (an
  overlay, no plugin or doc change) puts a marker with the open count beside each block with open
  threads and a hover "Comment" button (view-only readers too), and reports the doc's blocks; the
  block menu's **Comment** (Ctrl M, `BlockActions` `openComment`) opens a new thread. The top bar's
  Comments button opens `ui/CommentsPanel.tsx` (in place of the settings panel): Open · Resolved,
  threads by block in document order, "On hidden blocks" (#213) and "On deleted blocks" (orphans:
  their block id isn't in the doc; back on their block if a restore brings it back). The canvas
  draws no panel, so it's built from the settings panel's shell and the #338 components. Rules and
  wording: `lib/comments.ts` (tested, limits checked against the Go). Anchoring through move,
  split, Enter at the start (the thread stays on the new empty block above), join, paste, turn-into,
  restore and reseed, and for blocks inside a Group (#414: moving the group or the block out of
  it, a restart, a reseed): `lib/collaboration/comments.hocuspocus.test.ts`.
- **Per-block "Last edited by" (#328):** the block menu's footer, "Last edited by Ana Costa · 2
  hours ago" ("you" for yourself, "a former member" for a removed one, no line for a block with no
  attribution; `lib/blockEdits.ts`, tested). The data is the API's (`lib/api/blockEdits.ts`, `GET
  /posts/:id/block-edits`), never the Yjs doc: the collab server writes it with each store that
  writes `block_doc` (`collab-server/CLAUDE.md`). `Editor` owns one `PostBlockEditsStore`
  (`lib/blockEditsStore.ts`, memory only) per bound, editable post and provides it through
  `components/editor/blockEditsContext.ts` (so `DragHandle` passes nothing). It reads on bind and
  after every reconnect, and merges the rows each `stored` message carries (`edits`), with one
  more read for a user it can't name yet; a read answer never undoes a row merged meanwhile.
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
- **Callout, pull quote, to-do list (#419):** Text entries in the block catalog (Callout:
  `setParagraph().setCallout()`; Pull quote: `setPullQuote()`; To-do list: `toggleTaskList()`,
  Markdown `[]`, TaskItem's own input rule, so `catalog.markdown.test.ts` types it too). The
  callout's Type is its view's buttons (shown while the cursor is in it) and a picker in `BlockTypeToolbar` (`setCalloutTone`). Paste keeps
  `div[data-type=callout][data-tone]`, `figure[data-type=pull-quote][data-cite]` and
  `ul[data-type=taskList] > li[data-type=taskItem][data-checked]` with valid values only.
  Public markup in `src/components/blocks/README.md`; the default theme's callout colours are
  theme tokens (`info`/`infoBg`, …). History's diff treats a to-do list as a list (a ticked item is
  a "Done" change). Rules: `gl-admin/lib/collaboration/CLAUDE.md`.
- **Table block (#420):** a Text entry in the catalog (`/table`) whose insert opens the size
  picker (`components/editor/ui/TableSizePicker.ts`: a plain-DOM dialog at the caret, Columns 3 and
  Rows 2 to start, Rows counting the header row, Create table; Esc closes it and inserts nothing).
  The node and its commands are `extensions/TableBlock.ts` (schema in `schemaExtensions`, the keys in
  `TableKeyboard`, editor only); the view (Row ▾ and Column ▾ menus, the Header row switch, ⌥F10 to
  reach them, the grid in a scrolling `tableWrapper`) is `TableBlockView` in `BlockNodeViews.ts`.
  No slash menu, Turn into or "Type /" hint in a cell (paragraphs only) or a caption. The public
  `src/components/blocks/table/` and the default theme's `.table-scroll` rules (`theme.css`) make
  a wide table scroll in its own box at 375px. Rules: `gl-admin/lib/collaboration/CLAUDE.md`
  (blockBridge notes, Table). History compares its cells as text, the caption like an image's and
  the header row as an attribute.
- **Details (#421):** a Text entry in the catalog (`/details`, after Table: the line becomes its
  first block, the caret goes to the summary), the node `extensions/DetailsBlock.ts` (schema,
  commands, `DetailsKeyboard`) with its view in `BlockNodeViews.ts` (chevron, summary, the **Open
  by default** switch while the cursor is in it) and the same switch on the Block tab. No slash
  menu, Turn into or "Type /" hint in the summary (`TEXT_PART_NODE_NAMES`: captions and summaries).
  The public `src/components/blocks/details/` is the browser's own `<details>` (no script) and the
  default theme styles it. History diffs its summary like a caption and `open` as an attribute.
  Rules: `gl-admin/lib/collaboration/CLAUDE.md` (blockBridge notes, Details).
- **Custom HTML (#428, design `docs/design/block-library.md` 5):** the Advanced entry in the catalog
  (`/html`, admins only, the server enforces it). The node is `extensions/HtmlBlock.ts` (an atom
  holding a snippet id, never markup), the view `extensions/HtmlBlockViews.ts`: an admin gets HTML /
  Preview and a code field (Tab indents, Esc then Tab leaves; saved debounced, and flushed before
  Publish), everyone else the locked preview with "Only admins can edit this block", and can still
  move it (`ui/HtmlToolbar.tsx`). The markup is `lib/htmlSnippetsStore.ts`, memory only, from `lib/api/
  htmlSnippets.ts`; read when a block first asks, so a post without one costs no request. Previews
  show what the server kept (and through DOMPurify); a link in one doesn't navigate. The public
  `src/components/blocks/html/` outputs `attrs.html` and nothing else. Rules:
  `gl-admin/lib/collaboration/CLAUDE.md` (blockBridge notes), `api/CLAUDE.md` ("Custom HTML").
- **Columns, buttons, spacer (#426, design `docs/design/block-library.md` 2.2, 4):** Layout
  entries in the catalog (`/columns`, whose insert opens `ui/ColumnsPicker.ts`: four layouts, Esc
  inserts nothing; `/buttons`; `/spacer`). Nodes in `extensions/ColumnsBlock.ts`, `ButtonsBlock.ts`,
  `SpacerBlock.ts`, views in `extensions/LayoutBlockViews.ts` (toolbars, the Link field, the spacer's
  handle: ↑ ↓ one step, or drag), the Block tab in `ui/LayoutBlockSettings.tsx`. Rules, and what a
  removed column's blocks do: `gl-admin/lib/collaboration/CLAUDE.md` (blockBridge notes, Layout
  blocks). Public markup: `src/components/blocks/README.md`, the default theme's rules in
  `themes/default/styles/theme.css` (`themes/default/layoutBlocks.test.ts`).
- **Cover, media & text (#427, design `docs/design/block-library.md` 2.2, 3.4, 4):** Media entries in the
  catalog (`/cover`, `/media`, the line becomes the first block). Nodes and commands in
  `extensions/CoverMediaBlocks.ts`, views (toolbar, image, drop zone, missing state, "No alt text"
  flag) in `extensions/CoverMediaViews.ts`, the Block tab in `ui/CoverMediaSettings.tsx`, whose focal point
  takes ← → ↑ ↓ 1%, ⇧ 10%, and exact X and Y. Both use the shared picker, count in "Used in" and are left out
  of the page when their image is deleted, blocks included. Rules: `gl-admin/lib/collaboration/CLAUDE.md`
  (blockBridge notes, Cover and media & text). Public markup: `src/components/blocks/README.md`; the
  theme's contrast rule: `themes/README.md`.
- **Gallery (#424):** a Media entry in the catalog (`/gallery`, an empty gallery on the line, the
  caret in its caption). The node and its commands are `extensions/GalleryBlock.ts`; the view (a grid,
  **Add images** while the cursor is in it, and with no images the empty state: Upload and Choose from
  Media for a new one, "This gallery has no images" with Add images and Remove block once it had some
  or has a caption) is `GalleryView` in `BlockNodeViews.ts`; a tile is the image's own view
  (`ImageView`: Move earlier, Move later and Remove while selected). Keys: `extensions/GalleryKeyboard.ts`.
  The settings panel's Block tab is `ui/GallerySettings.tsx` (Columns, then the images one by one, "No
  alt text" per image; the selected image's row opens Alt text and Caption, a gallery image selecting
  shows the gallery's panel with that row open). Images come from the shared picker's multi-select
  (`chooseGalleryImages`, `addMediaToGallery`) or Upload (`uploadGalleryImages`, several at once), one
  transaction each. The public `src/components/blocks/gallery/` and the default theme's `.gallery`
  rules (two columns at 640px). History diffs the caption like a caption, columns as an attribute and
  the images as children. Rules: `gl-admin/lib/collaboration/CLAUDE.md` (blockBridge notes, Gallery).
- **Footnotes (#422, design `docs/design/block-library.md` 2.2, 2.9, 4):** a Text entry in the catalog (`/footnote`, `inline`: any slot whose
  text takes one) and the selection toolbar's Footnote. Both call `insertFootnote`: the reference, its note in the post's list, the caret in the
  note. The list's rows are `FootnoteView` (`extensions/FootnoteEditing.ts`): number, ↩, and "Not referenced" with Remove. The Block tab (the list's)
  says how many. Published: `section.footnotes` with `fn-N` / `ref-N` anchors both ways, in `src/components/blocks/footnotes/`, numbers from
  `FootnotesContext` (`BlockRenderer`). Rules: `gl-admin/lib/collaboration/CLAUDE.md` (blockBridge notes, Footnotes).
- **Inline marks (#418, design `docs/design/block-library.md` 3.3):** Highlight, Superscript and
  Subscript in the selection toolbar (`ui/BubbleMenu.tsx`, after Link; not in a caption), ⌘⇧H,
  ⌘. and ⌘,. The marks are `extensions/InlineMarks.ts` (rules, the concurrent-edit case and the
  API's mark allowlist: `gl-admin/lib/collaboration/CLAUDE.md`). The editor styles them from
  `--editor-highlight` (`_tokens.scss`, contrast in `tokens.test.ts`); the public renderer writes
  `<mark>`, `<sup>`, `<sub>` (a stored colour never becomes a style) and every theme styles them
  (`themes/README.md`). Paste keeps `mark`/`sup`/`sub` without attributes and turns Docs/Word
  `vertical-align: super|sub` spans into `sup`/`sub`.
- **@ mentions, content links and dates (#320, the canvas's "Editor menus & states" ›
  "Mention / link to content (@)"):** "@" after a space or at the start of a line (not in code
  or a caption) opens `components/editor/ui/MentionMenu.tsx`: People, "Link to post or page",
  then the dates (Today, Tomorrow, a typed YYYY-MM-DD, "Date or reminder"), in the slash
  menu's list styles and keys (focus stays in the text with `aria-activedescendant`, ↑↓ across
  groups and wrapping, ↵, Esc keeps the text, Tab closes; with nothing matched ↵ stays the
  editor's). Results come from `lib/api/mentions.ts` (debounced, one answer per query, memory
  only); the order and rows are `lib/mentionMenu.ts` (tested). "Date or reminder" opens
  `ui/DateChipDialog.ts` (Date, optional Time, **Remind me**: an email to whoever set it then,
  in the site's zone; must be ahead). The popup is the slash menu's `SuggestionPopupManager`
  (`utils/slashCommandManager.ts`, `utils/mentionMenuManager.ts`). Nodes, views and rules:
  `gl-admin/lib/collaboration/CLAUDE.md` (blockBridge notes, Inline nodes). **Public:** the API
  sends a mention as its member's current name and a link with its target's current URL (none
  for a draft: plain text); `PostPage.astro` gives date chips the site's format
  (`src/lib/dateChips.ts` `labelDateChips`) before the theme renders; markup in
  `src/components/blocks/README.md`. Mentions in block comments are not built (comments stay
  plain text).
- **Embeds (#425, design `docs/design/block-library.md` section 5):** YouTube, Vimeo, X and "Embed a
  link" in the catalog's Embeds group (`roles`: editors and admins, who are who may resolve a link).
  Nothing from a provider loads until someone clicks, in the editor and on the site. The table is
  `blocks-spec/embeds.ts` (players, frame hosts, ref patterns); the words for a link that can't be
  used are `components/editor/blocks/embedLinks.ts`; the view is `extensions/EmbedBlockViews.ts`
  (link field, placeholder, player), with `ui/EmbedToolbar.tsx` and `ui/EmbedBlockSettings.tsx`. A
  player opened in the editor is that view's alone, never in the doc. On the site the placeholder is
  `src/components/blocks/embed/`, with no provider address in it; `public/gl-embeds.js` (plain,
  unbundled, its templates compared with the table by `EmbedBlock.test.tsx`) builds the player on
  click, with `sandbox`, `referrerpolicy` and `loading`, and moves focus in. `BlockRenderer` adds
  that script only for a post with an embed. X loads its widget on click on the site; in the editor
  it is a plain iframe of the post, because the admin's `script-src` stays closed. **Public CSP:**
  `applyPublicCsp` (`src/middleware/csp.ts`) sends one directive, `frame-src`, the allowed providers'
  hosts (`'none'` if the settings can't be read); no other directive, so themes are unaffected. The
  admin's CSP frames every provider's host.
- **Editing nested blocks (#417, design `docs/design/block-library.md` 3.5):** the gutter is
  our own plugin now (`components/editor/utils/gutterPlugin.ts`; TipTap 3.4.2's drag handle
  only finds top-level blocks): it follows the pointer to the innermost block (a block in a
  group; the group in its own left margin), and runs the drag: the drop line and target
  follow the nesting table (`blockTree.ts` `dropTargetFor`), the drop is one move
  (`applyBlockMove`, rules in `gl-admin/lib/collaboration/CLAUDE.md`). `ui/DragHandle.tsx`
  renders the gutter through a portal into the plugin's element; the + offers only what the
  block's container accepts (`gutterAccepts`). Keyboard (`extensions/BlockNavigation.ts`):
  Esc selects the block around the caret, then its container; ↵ steps into a container's
  first block or edits a block; ↑↓ move between the blocks beside it; ⌘⇧↑/↓ move it inside
  its container; ⌫/Del delete a selected block (a container it leaves empty goes too);
  Tab reaches + and the handle, then the block's own toolbar (`data-block-toolbar`, a
  group's Width and Background: ← → move, Esc back); ⌘⇧, opens the settings panel's
  **Block** tab (`ui/BlockSettingsPanel.tsx`: the selected block nested or not, its path of
  containers, a group's settings; `Editor`'s `onEditorReady` hands it the editable editor).
  Presence inside containers: `utils/cursorAwareness.ts` (label flip and stacking, remote
  block outlines). Tests: `BlockNavigation.test.ts`, `blockTree.test.ts`,
  `DragHandle.test.tsx`, `BlockSettingsPanel.test.tsx`, `cursorAwareness.test.ts` and the
  relay's `blockMoves.collab.test.ts`.
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
- **Media blocks and the media picker (#423, design `docs/design/block-library.md` 3.4, 2.10):**
  `components/media/MediaPicker.tsx` is the one picker (it replaced `MediaSelector` and
  `FeaturedImageSelector`): a `kind` (`image`/`video`/`audio`/`document`, the API's `type`; without
  one, the library's kind filter), one file or several (`multiple`, `onSelectMany`), **Upload** in
  place (`lib/mediaLookup.ts` `uploadMediaFile`, the library's own upload, which `pages/Media.tsx`
  uses too; picks what it uploaded), "No alt text" on images (#325), Remove for the file in use
  (`removeLabel`; the featured and social images keep their wording), every tile a button (arrow
  keys, Home, End). In the editor, plain-DOM node views ask for it through
  `components/editor/blocks/mediaPicking.ts` (`chooseMediaFor`, `uploadMediaFor`; the block is
  found again by id when the file arrives), and `ui/MediaPickerHost.tsx` (mounted by `Editor`)
  shows it; image placeholders open it too. Video, audio and file are Media entries in the catalog
  (an empty block: Upload / Choose from Media), nodes in `extensions/MediaBlocks.ts` (schema and
  commands), views in `extensions/MediaBlockViews.ts` (the player, the download row with its
  label field, the missing state), Replace and Caption on the media toolbar (`ui/ImageToolbar.tsx`,
  every media block now) and the file with Replace in the settings panel's Block tab
  (`ui/MediaBlockSettings.tsx`). **Missing media:** the views look the media up
  (`lib/mediaLookup.ts`: 404 = missing, "The video file is missing" with Replace, the image's too;
  any other failure is not shown as missing); the API lists deleted ids in `media_missing` and the
  public renderer leaves those blocks out with their caption (`src/components/blocks/README.md`).
  History's preview fills the `media` map from the same lookups (`lib/docMedia.ts`). The admin CSP
  has `media-src` for the players. Rules: `gl-admin/lib/collaboration/CLAUDE.md` (blockBridge
  notes, Media blocks).
- **Command palette (#41; the canvas's "Search · command palette"):** the sidebar's Search
  button or Ctrl/⌘ K (`components/command-palette/CommandPalette.tsx`, mounted in `AppLayout`,
  opened through `openCommandPalette`). In the block editor (`isEditorFocused`: focus inside
  `.ProseMirror`) Ctrl K stays the link dialog (`OpenLinkModal`'s `Mod-k`); it doesn't open over
  another `aria-modal` dialog either (that dialog's Tab trap would take focus).
  One call, `GET /search?q=` (`lib/api/commandPalette.ts`, `api/command_palette.go`), debounced
  150 ms; every change aborts the request before it (`apiCall`'s `signal`) and an answer for
  other text is never shown. Rules, what each result opens and the group order are
  `lib/commandPalette.ts` (tested): jump actions first (they need no answer, so the highlighted
  row doesn't move when results arrive), then Posts, Pages, Media, Terms, Users. Settings and
  Users are admins' only; a role without content access gets no search. Rows and keys are the
  slash menu's (the field is the combobox, `aria-activedescendant`, ↑↓ wrap across groups), but
  it's a modal: Tab stays inside, Esc returns focus to where it was. A term opens as
  `/taxonomies?type=&term=`, which opens its panel for editors and admins.
- **Accessibility (#144):** `app.tsx` renders `div#admin` with one `<main id="main-content">`
  (the routed page; the sidebar, palette and toaster sit beside it, never in it) and a "Skip to content"
  link as the first Tab stop (it makes `<main>` focusable only until it blurs, so clicks on page text
  don't focus it); nothing else may be a `<main>`. The editor's floating toolbars (BubbleMenu,
  BlockTypeToolbar, Image/Embed/Html toolbars) carry `data-floating-toolbar` and call
  `onFloatingToolbarKeyDown` (`components/editor/utils/floatingToolbar.ts`): ⌥F10 from the text
  (`FloatingToolbarKeys`, a keymap only: rule 7), ← → Home End inside, ⌥F10 to the next one, Esc back
  with the selection kept. A new floating toolbar needs both. `CommandSelect` is a keyboard listbox.
  Focus rings are `--focus-ring` (global `:focus-visible`; menu rows `mixins.menu-row`'s inset ring).
  **`axe-core`** (exact dev dependency) runs in vitest: `gl-admin/components/ui/axe.test.tsx` renders
  components with react-dom into jsdom (contrast off: `tokens.test.ts` owns it); add new shared
  components and editor chrome there. The public site (#481): `src/components/blocks/axe.test.tsx` (a post
  body with the audited blocks) and `themes/default/theme.astro.test.ts` (every default-theme layout,
  rendered whole, axe loaded into a JSDOM window). Remaining findings: the Post-MVP issues linked from
  #144 (video captions: #507).
- **Editor announcements and shortcuts (#477):** a live region must be in the page, empty, before
  it speaks, and should speak transitions, not every render. The top bar's `SaveAnnouncer`
  (`EditorTopBar.tsx`, rules in `saveAnnouncement`) is the one status region for the save state and
  stays mounted when view-only, ended or in History: reconnecting, offline, back online, "Latest
  edits not saved" and "Edits saved" after it; the visible `SaveState` and the offline banner are
  not live. Character counters (`Textarea`, the excerpt, SEO title and description) are the
  field's description only; `components/ui/CountAnnouncer.tsx` speaks near or over the limit once
  typing pauses (`lib/countAnnouncement.ts`). The slash and + menus' `InsertMenuStatus` reads the
  result count after a pause. **Shortcuts:** `components/editor/utils/shortcuts.ts` `KEYS` are the
  strings the keymaps bind (block keys, ⌥F10, link, block menu), so the reference can't drift;
  `MARK_SHORTCUTS` are TipTap's, pressed in a real editor by `shortcuts.test.ts`. A new editor
  shortcut goes in `KEYS` and `shortcutSections`. The reference (`ui/ShortcutReference.tsx`, a
  `Modal`) opens on "?" outside text and from the block menu's Keyboard shortcuts; the editable
  text's description names ⌥F10 (`editorKeysHint`).
- **Routes, forms and feedback (#479, #480):** every routed page calls `usePageTitle("…")`
  (`lib/hooks/usePageTitle.ts`; `routeFocus.test.tsx` fails on a route whose page doesn't), and
  `AppLayout`'s `useRouteFocus` moves focus to the new page's `<h1>` (or `<main>` after 3 s) on a path
  change, unless the page took focus itself. The editor pages render a visually hidden `<h1>`
  (`lib/editorHeading.ts`: "Edit post: …"). `aria-activedescendant` lists (Select/Combobox `Listbox`,
  the slash/+/@ menus, the palette) get the inset ring on `[data-active="true"]` / `.is-active` while
  `<html data-input-modality="keyboard">` (`a11y.ts` `installInputModality`; the mouse keeps only the
  fill): it's in `mixins.menu-row`, so a new list row gets it by using the mixin. Modal and Drawer
  render in place and make the rest of the page `inert` (`useInertOthers`; skips `[data-inert-exempt]`,
  the toaster, and anything holding `.ProseMirror`). `Input` ids are `useId`; `aria-invalid` only with an
  `error`, whose `FieldError` is `role="alert"`; after any form submit the first invalid field gets
  focus (`installSubmitFocus`). Combobox's Escape with the list closed does nothing (a dialog closes).
  Toasts: errors and toasts with an action stay until dismissed; **F6** (`TOASTER_SHORTCUT`) goes to the
  newest toast and back. Tooltips are hoverable (a 120 ms hide delay) and describe the target's first
  focusable element, any component. Account pages: `formUi.showError(message, { fields })` marks only
  the named inputs (`accountErrorFields`, the `*Problem` validators) and focuses the first; notices go
  through `#statusAnnouncer` (`AccountError.astro`), never a live region that starts hidden.
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
