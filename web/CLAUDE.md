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
