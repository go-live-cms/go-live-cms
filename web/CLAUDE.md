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
</content>
