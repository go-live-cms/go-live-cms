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
- Yjs runs natively in Node — managers are tested against a real `new Y.Doc()`.
- CI runs `npm test` on **Node 22** (`.github/workflows/ci.yml` `web-tests` job).
  jsdom 29 needs Node ≥20.19, hence 22.

## Editor lives under `gl-admin/`

The collaborative editor and its persistence/sync layer are the most fragile part of
the codebase. **Before editing anything under `gl-admin/components/editor/` or
`gl-admin/lib/collaboration/`, read `gl-admin/lib/collaboration/CLAUDE.md`.**

## Misc

- **Auth / 401s:** `apiCall` (`gl-admin/lib/api.ts`) treats a 401 as "the server
  revoked this token". It calls `authManager.forceRefresh()` and retries once,
  ignoring the local expiry, because a password change invalidates access tokens
  early. `/auth/*` endpoints are excluded (there a 401 means bad credentials). A
  failed refresh clears auth, except a **429** (API rate limit, #190): then the user
  stays signed in and `authManager` retries after `Retry-After` (`RefreshError`).
  `blockAPI.ts` does NOT go through this: it throws `UnauthorizedError` to the collab
  persistence layer.

- TipTap is on **v3** (breaking from v2). `setContent`'s 2nd arg is an options object
  `{ emitUpdate }` — NOT the v2 boolean. `emitUpdate:false` only suppresses TipTap's
  `update` event; the collaboration ySyncPlugin still mirrors content to Yjs regardless.
- StarterKit's bundled undo/redo is **disabled when collaborating** (`undoRedo:
  collabProvider ? false : undefined` in `editor/utils/extensions.ts`, #197) —
  Collaboration ships its own Yjs-aware history. Keep it for non-collab editors.
- **`yjs` is pinned to `13.6.31` (exact, no `^`) and must match `websocket/`'s pin.**
  The two packages have separate lockfiles; loose ranges drifted apart once and
  contributed to collab data corruption. See
  `gl-admin/lib/collaboration/CLAUDE.md` rule 8 and `websocket/CLAUDE.md`'s top gotcha
  (dual ESM/CJS instance) before touching any yjs-family dependency.
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
  the edit modal sets the focal point with `FocalPointPicker`. Image blocks keep
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
- `prosemirror-utils` `1.2.2` is pinned exact too. `y-websocket` `2.1.0` and
  `y-protocols` `1.0.7` are pinned exact here and `y-websocket` in `websocket/` (rule 8).

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
   vitest run` (blockBridge round-trips, BlockId, persistence manager).
5. **Manual editor pass**: create, edit, save and reload every block type; drag a block
   to reorder; slash menu, bubble menu, character count.
6. **Two-user collab test**: log in as two users in separate browser contexts on the
   same post; type in both and check both see each other's edits and cursors; reload
   both and confirm nothing was lost or duplicated; publish and check the public page.
   Watch the websocket container logs for errors while doing it.
7. **Keep `yjs` / `y-websocket` / `y-protocols` in lockstep with `websocket/`** — never
   change them as a side effect of a TipTap bump (see rule 8 in
   `gl-admin/lib/collaboration/CLAUDE.md`). If a new `y-tiptap` needs a newer `yjs`,
   bump `web/` and `websocket/` together in the same PR.
8. Update the version and review date at the top of this section.
</content>
