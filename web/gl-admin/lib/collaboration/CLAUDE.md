# Collaboration / editor — agent context (READ BEFORE EDITING)

This is the **most sensitive subsystem in the codebase**. It has bitten us repeatedly
with data-loss and feedback-loop bugs. It has real test coverage — keep it green and add
to it. Run `npm test` from `web/` after any change here. The server half lives in
`web/collab-server/` (read its `CLAUDE.md` too).

## The model (#206, Hocuspocus)

The editor is a **bound editor and nothing else: it never seeds the doc and never saves
content.** The Hocuspocus server (`web/collab-server/`) owns persistence:
- it **seeds** a new doc from `posts.block_doc` (`onLoadDocument`, only when no valid
  stored Yjs state exists), under a new `meta.epoch`;
- it **stores** the Yjs state (`post_ydoc_state`) plus the derived, validated `block_doc`
  through the API's internal `PUT /internal/posts/:id/collab` (debounced, and on flush);
- it tells every client with stateless messages (`stored` / `store_failed`).

`posts.block_doc` stays canonical for everything outside the editor (SSR, publish,
versions, media sync), and **only the collab server writes it** for an existing post.
Publish asks the API, which flushes the collab server before reading `block_doc`.

**History:** until P5 (#285) a y-websocket server (`websocket/`, LevelDB) relayed the doc
and every client autosaved through `PUT /posts/:id/blocks`, which made the client
reconcile three stores (its Yjs doc, LevelDB, `block_doc`). Every bug class of the
2026-06 data-loss saga came from that: seed races, cache divergence, echo loops and
revision conflicts. The decisive root cause of the saga (PR #204) was a **dual yjs
instance (ESM+CJS double-load) in the server process**; rule 13 guards it now. The
debugging lesson stands: the yjs warning "Yjs was already imported" had been printed at
every server boot — **read process logs from the very top**.

## Files

- `HocuspocusCollaboration.ts`: `HocuspocusProvider` per post, ref-counted
  (`acquireHocuspocus` / `releaseHocuspocus`). A fresh ticket per (re)connect
  (`getTicket`, in Hocuspocus's auth message, **never the URL**, #233); `meta.epoch` put
  on the socket URL (`?epoch=`) after each sync; `stale-epoch` → `onStale` + destroy
  (holders remount on a fresh Y.Doc; `acquireHocuspocus` never hands a stale one out);
  auth retry with backoff for `access-unavailable` / ticket failures; `onStore` for the
  server's `stored` / `store_failed` messages. No `resyncInterval`. **Access changes
  while connected (#313):** the server's re-check sends `{type:"access", mode, reason}`
  (`demoted` / `unverified` / `restored`) or closes the doc with `access-revoked`;
  `onAccess` / `getAccess()` / `readOnly` follow it. A revoke sets status `revoked`,
  disconnects for good (never handed out again by `acquireHocuspocus`) and **keeps the
  Y.Doc**; the next authentication (a reconnect) replaces any earlier access message. A post
  moved to the trash (#327) closes (or refuses at connect) with `post-trashed`: handled as a
  revoke with `trashed: true` in `getAccess()`, so `AccessNotice` says so and nobody is sent
  to sign in again. **A
  promotion with unsynced changes reconnects:** updates sent while read-only were dropped
  by the server (acked as not applied, so still counted as unsynced) and Yjs never resends
  them, so every later update would wait on the server for them and never be stored; the
  reconnect's sync handshake sends them (pinned by `accessChange.hocuspocus.test.ts`).
- `postCollab.ts`: wires it to the app (URL from `backend.ts` `hocuspocusUrl`, tickets
  from `POST /collab/tickets`, the cursor label).
- `backend.ts`: `hocuspocusUrl`: `PUBLIC_COLLAB_URL`, else dev `ws://<page host
  name>:1235`, else `/collab` on the page origin (Caddy). Also feeds the admin CSP.
- `CollabSaveStatus.ts`: Saved/Saving/Error from those messages (only local edits make it
  "saving"; `kept-invalid` is an error), `waitForStored` (waits for the provider to have
  no unsynced changes, then the next `stored`), and `meta.dropped` for the hidden-blocks
  notice.
- `liveRestore.ts`: rule 9. `setEditorBlockDoc`, then the version's dropped record into
  `meta.dropped`, then await `stored`.
- `components/editor/Editor.tsx`: theme gate → connect → first sync → schema gate (rule
  10) → bind. Users who may read but not edit the post (a contributor on someone else's
  post, `postEditorAccess` in `lib/roles.ts`) get a **live read-only** view; the server
  makes that connection read-only anyway. `LiveGate` follows `onAccess`: a demotion
  turns the editor view-only with a notice (the bound doc stays, nothing is reloaded), a
  promotion back makes it editable, a revoke keeps it read-only with "session ended, sign
  in again" (`authManager.logout("session-expired")`). Publish waits for the server to have every
  local edit, then calls publish; the API flushes. `useCollabPresence` and `PostForm`
  (title saved on its own via `PUT /posts/:id`; a new post sends its body as `block_doc`
  with `POST /posts`) share the same connection. That body is the unbound editor's
  document through `pmToBlockDoc` (`EditorRef.getBlockDoc`, null when empty), the bridge
  the server stores with. **Never build it from the editor's HTML** (#384): an HTML
  converter kept text only, so every mark typed before the first save was lost.
  `onStored` (#326) only listens to the server's `stored` messages (`block_doc: "written"`,
  anyone's edits) so the form can re-read "Changes not published"; it changes no sync
  behaviour.
- `blockBridge.ts`: `pmToBlockDoc` / `blockDocToPM(WithReport)` / `setEditorBlockDoc`.
  Pure conversion (notes below).
- `fragmentBridge.ts`: `seedFragment` / `fragmentToBlockDoc`: Block Spec v1 ⇄ the
  `"default"` XmlFragment with no editor, for the server. Same bridge, same schema, plus
  stand-ins so unknown nodes survive. Seeding returns `DroppedBlocks` (entries **and**
  their block trees); the server keeps that record in `meta.dropped` and passes it to
  every store, or the blocks the editor can't show (#213) are deleted. The store converts
  each top-level node on its own: one it can't build is reported (`onUnconvertible`) and
  keeps its version from `previous` (the last stored doc). `stampFragmentBlockIds` gives
  nodes without a valid, unique id one in the live doc, by BlockIdExtension's rules, in
  one transaction; the server runs it before each store, or `pmToBlockDoc` would mint a
  new random id for those nodes on every store. Tests: `fragmentBridge.test.ts` (plain
  Node) and `fragmentBridge.editor.test.ts` (editors bound to a server-seeded doc).
- `schema.ts`: `schemaExtensions()`: the schema-defining extensions, configured as the
  editor configures them, with no DOM or React. `components/editor/utils/extensions.ts`
  builds its list from them, so **change editor schema config there, not in
  extensions.ts**. `getCoreSchema()` builds the schema in plain Node
  (`schema.node.test.ts`), and `schema.test.ts` fails if the editor's schema and the core
  schema ever differ. `getCollabSchema(themeExtensions)` adds theme blocks' **headless**
  nodes; `getInstalledCollabSchema()` (`lib/theme-blocks/collabSchema.ts`) is the core
  schema plus every installed theme block, what the collab server converts with and what
  the editor's schema must equal (`schema.test.ts`; see "Theme blocks" below).
  `schemaWithStandIns(base, pmJson[])` adds a permissive, cached stand-in for every
  node or mark type in the JSON that `base` doesn't know, keeping its attrs. A stand-in
  checks nothing.
- `schemaGuard.ts`: `findUnbuildableTypes` for rule 10.
- `debug.ts`: gated logging. Browser: `localStorage.setItem("GL_DEBUG_COLLAB","1")`.
  Server: `COLLAB_DEBUG=1`. Both timestamped (`t=…`) so client and server logs align.

**The Yjs doc** (`post-<id>`) holds the **`"default"` XmlFragment** (the editor content;
TipTap's Collaboration with no `field` option. **It is NOT named `"prosemirror"`**: code
reading `getXmlFragment("prosemirror")` reads an always-empty fragment) and the
server-owned **`meta`** map (`epoch`, `dropped`). The pre-#206 `blocks` / `blocks_order`
mirror is gone; the server empties it if an old stored doc still has one.

## Hard rules (violating these reintroduces shipped bugs)

Rules 1–6 (client autosave, the incremental Block Spec mirror, client seeding) were
deleted with the client persistence layer in P5 (#285). The numbers of the others are
kept so references in code stay valid.

0. **No client-side `IndexeddbPersistence` (or any client cache that survives
   reloads).** The server's Postgres Yjs state (`post_ydoc_state`) is the **single live
   store**. A local Yjs cache builds a *different struct history* for the same content
   than the server's doc; the two never converge, and merging them duplicates or reverts
   content, compounding on every reload (the 2026-06 "heartbeat" that erased text and
   images). On open, the editor loads purely from the server. The epoch guard (rule 12)
   is the server-side counterpart: a client holding structs of an older seed must drop
   its Y.Doc, never merge.

7. **Editor plugins with `appendTransaction` (or `filterTransaction`) MUST ignore
   collaboration-sync transactions.** `components/editor/extensions/BlockIdExtension.ts`
   assigns `data-block-id`s; it once ran on *every* `docChanged`, including the
   transactions `ySyncPlugin` dispatches for **remote** Yjs updates, and minted a fresh
   `crypto.randomUUID()` each time: a sync→appendTransaction→sync feedback loop (random
   ids never converge). Guard with TipTap's `isChangeOrigin(tr)` (from
   `@tiptap/extension-collaboration`): `if (transactions.some(tr => isChangeOrigin(tr)))
   return null`. Only the client that originates a node assigns its id (top-level nodes
   and list items, #238); remote ids arrive as synced attributes, and the server stamps
   any still missing before a store (`stampFragmentBlockIds`). Read-only peers receive
   the same sync transactions. Any future doc-mutating plugin must do the same.
   (BlockIdExtension also regenerates **duplicate** ids: splitting a block copies attrs,
   including the id, onto the new node, and `block_doc`'s `blocks` map is keyed by id, so
   duplicates silently collapse blocks. Keep both checks.)

8. **`yjs` is pinned exact (`13.6.31`, no `^`) in `web/package.json`, and `web/` is the
   only package.** The editor, the collab server, TipTap's y-tiptap and
   `@hocuspocus/*` all resolve the same copy from web's one lockfile, so client and
   server can't drift apart (they did once, when `websocket/` had its own lockfile, and
   mixed yjs versions can mis-integrate complex struct operations). `y-protocols`
   (`1.0.7`) and `@hocuspocus/server` / `@hocuspocus/provider` (`3.4.4`) are pinned exact
   too. Check with `npm ls yjs y-protocols` (one deduped copy each) after touching any
   yjs-family dependency. Never add a dependency that brings its own yjs.

9. **Restoring a version (#136) goes through the editor, never around it.**
   `restoreVersionLive` (`liveRestore.ts`) applies the doc with `setEditorBlockDoc`,
   which the ySyncPlugin mirrors to every peer as an ordinary edit, adopts the version's
   dropped-block record into `meta.dropped`, and waits for the server's next `stored`.
   Writing `posts.block_doc` behind the live doc would be undone by the next store (rule
   11). A version's settings (title, excerpt, featured image, terms; #358) aren't in the
   Yjs doc: after `restoreVersionLive`, `PostForm` calls the API's restore-settings route,
   which writes them into the working copy (the live post waits for Update).
   Comparing a version with the working copy ("Highlight changes", #355,
   `lib/history/`) is read-only and goes around the editor on purpose: it reads the
   stored `block_doc` over REST (re-read on `stored`), never the Yjs doc or the editor's
   state, so it can't disturb either.

10. **Never bind Collaboration to a doc the editor's schema can't build (#206/#274).**
   `@tiptap/y-tiptap` 3.0.0's `createNodeFromYElement` / `createTextNodesFromYText`
   catch a failing `schema.node()` / `schema.text()` and **delete that element (or text
   run) from the shared Y doc**: an unknown node type (a node from a newer collab bundle,
   a pre-#376 custom type kept by a stand-in) or an unknown mark vanishes
   for every peer, and the next store persists the loss. `Editor.tsx`'s gate waits for
   the first sync, runs `findUnbuildableTypes` (`schemaGuard.ts`) on the `"default"`
   fragment against `getSchema(getExtensions(...))`, and only then binds. If anything
   can't be built it binds **nothing** and shows a static read-only view from
   `GET /posts/:id/blocks` with a notice naming the types; save, publish and restore
   throw. **Not covered:** a peer inserting an unknown type *after* this editor bound (a
   newer theme on another client) is still deleted by y-tiptap. Pinned by
   `schemaGuard.test.ts` (the deletion itself + detection) and `Editor.test.tsx`.

11. **Only the server seeds, and nothing writes `block_doc` around the collab server.**
   `onLoadDocument` is the only place a doc is seeded, and only when no stored Yjs state
   matches the post's current `block_revision`. The client never seeds and never writes
   content outside the editor (no REST save exists any more). The only writers of
   `block_doc` are the collab server's store (`PUT /internal/posts/:id/collab`), and for a
   new post's initial body (nothing is live yet) `POST /posts`, `POST
   /posts/:id/duplicate` (#354: a copy with new block ids and no Yjs state, seeded like
   any new post; `duplicatePost.collab.test.ts`) and `POST /post-templates/:id/posts`
   (#322: a template's content with new block ids, the same Go function, no Yjs state;
   `postFromTemplate.collab.test.ts`). Templates themselves live in their own table and
   never reach the collab server. A server-side
   restore, import or migration tool would have to go through the collab server
   (`openDirectConnection`, #286), not `UPDATE posts`.

12. **The revision and epoch guards stay.** `post_ydoc_state` records the
   `block_revision` it was stored at; if `block_doc` was written some other way anyway (a
   restored backup, a manual fix), the API withholds the stale state and the server
   reseeds under a **new epoch**. A client that still holds structs of the old seed
   connects with `?epoch=<old>`, is refused with `stale-epoch`, and must destroy its
   Y.Doc and reconnect fresh: merging old structs into a reseeded doc duplicates the
   content. Never drop either guard, and keep `stale-epoch` handling in every client.

13. **One yjs instance in the server process.** Two yjs builds in one process (ESM
   `yjs.mjs` + CJS `yjs.cjs`) have separate class registries; cross-instance
   `Y.applyUpdate` silently corrupted live docs in the 2026-06 saga. The server image
   runs an esbuild bundle that resolves every `yjs` / `lib0` / `y-protocols` require as
   the ESM build, a startup probe exits on mismatch, and `process.test.ts` fails on
   "Yjs was already imported". In-process vitest can't reproduce this (see
   `web/collab-server/CLAUDE.md`).

14. **Empty docs: normalize `{}`, and don't store a still-empty post (#304).** Posts that
   never had blocks store `block_doc` = `{}`. The server maps only `null`/`{}` to "empty"
   (`normalizeBlockDoc`) and seeds an empty fragment; **any other malformed shape fails
   the load** (the connection is refused) rather than showing an empty editor whose
   next store would overwrite unknown content. A store whose result is still empty
   (nothing, or only the empty paragraphs TipTap adds on open) for a post whose
   `block_doc` was empty is a **no-op** (no `block_revision` / `changed_at` bump for a
   post nobody edited). Separately, an empty result is written only if a client edited
   the doc since it was loaded, never after a failed seed (`collab_store_empty_skipped`).
   The REST reads (`GET /posts/:id/blocks`, `/versions/:no`) return `{}` as a
   well-formed empty doc.

## blockBridge notes

- Every block node type needs the **`data-block-id`** attr (added globally by
  `BlockIdExtension` to paragraph/heading/blockquote/codeBlock/horizontalRule/image/
  bullet_list/ordered_list/listItem). Custom/theme nodes must declare it too or
  `schema.nodeFromJSON` throws "Unsupported attribute".
- `pmToBlockDoc` regenerates duplicate/invalid block ids.
- **Known limitation:** a `code_block` with empty code can't be shown in the editor
  (ProseMirror disallows empty text nodes). It is dropped like any other unbuildable
  block (see below), not thrown for the whole doc. Pinned by a test.
- **`schema.nodeFromJSON` does NOT validate content expressions**: it will happily build
  a schema-invalid node. Tests prove validity with `node.check()`.
- **Dropped blocks are hidden, never deleted (#213).** `blockDocToPMWithReport` builds
  and `check()`s **each top-level block, and each list child, on its own**. One that
  fails to build or check is left out and reported as a `DroppedBlock` (its id, its
  parent list or null, and the sibling it followed). It never throws for the whole doc:
  an editor left empty would have its next store overwrite the entire working copy. The
  server keeps the record in `meta.dropped` and `restoreDroppedBlocks` merges them back
  into every store, at their original position or at the end if their anchor was
  deleted. The doc-level `block+` rule is not checked (an empty block doc stays an empty
  PM doc).
- **List children:** the schema requires `listItem+`. A `paragraph` child is wrapped in a
  `listItem` (keeping its text and id); any other non-`listItem` child is dropped as
  above. A list left with no items gets **one synthesized empty `listItem`**, keeping the
  list's block id and position. Its id is **deterministic (`synthesizedItemId`:
  `<listId>-list-item`, always ≥ 10 chars)**, so the same block doc gives the same item
  id on every load and the store sees no change. `pmToBlockDoc` **skips** a childless
  list node, so a childless list block is never persisted.
- **List item ids (#238):** `BlockIdExtension` stamps every `listItem` whose parent is a
  `bulletList`/`orderedList` (any depth), regenerating missing/invalid/duplicate ids
  deduped across the whole doc. Pinned by
  `components/editor/extensions/BlockIdExtension.test.ts` (headless `Editor`). Note for
  such tests: StarterKit's TrailingNode appends its own transaction (no sync meta) when
  the doc ends in a list, which re-runs `appendTransaction` without the rule-7 guard.
- **Paste (#128):** `components/editor/extensions/PasteSanitizer.ts` runs pasted HTML
  through DOMPurify (`transformPastedHTML`, local pastes only; no appendTransaction, so
  rule 7 doesn't apply) and the schema's parse rules turn the rest into nodes. It strips
  every `data-block-id` (also inside ProseMirror's `data-pm-slice` context), so pasted
  nodes always get fresh ids from BlockIdExtension and a copied id can never re-key the
  original block. Pasted images are dropped by design (insert via the media library).
  Pinned by `PasteSanitizer.test.ts` and `PasteSanitizer.collab.test.ts`.
- **Cycles:** `listItemsToPM` tracks the lists being converted. A list that (directly or
  through another list) contains itself throws at the child that closes the cycle, so
  that child is dropped and reported like any other bad child.
- **Image caption + width, quote citation (#346): image and blockquote are Block Spec
  v2** (`IMAGE_BLOCK_VERSION`, `BLOCKQUOTE_BLOCK_VERSION`); readers take v1 and v2, a
  missing attr is its default, so old docs load and render as before.
  - **Caption = a child node, not an attribute.** `image` has `content:
    "imageCaption?"` (`isolating`); `imageCaption` is `text*` with marks `bold italic
    link` (`CAPTION_MARKS`), brought in by `ImageWithMediaId.addExtensions`. A child so two
    people typing in one caption merge per character in Yjs (an attr is last-writer-wins
    on the whole string), and not the image's own inline content, which would make the
    image a textblock that turn-into/setBlockType could replace. No caption = **no child**
    (every pre-#346 image, so old Yjs docs stay schema-valid); the toolbar/"Add caption"
    inserts an empty one, Backspace in an empty one removes it, Enter leaves it.
  - **Block Spec:** `attrs.caption` is the child's content as PM JSON (`CaptionText[]`:
    text runs with caption marks). `pmToBlockDoc` leaves it out when there's no child or
    it's empty; `blockDocToPM` builds the child only for a non-empty caption and keeps
    only text runs and caption marks (a bad mark costs the mark, not the image).
  - `align` (`"inline" | "wide" | "full"`, `IMAGE_ALIGNS`) is an image attr; stored only
    when not `inline`, and an unknown value loads as `inline`.
  - `cite` is a plain-text `blockquote` attr (`QuoteCitation`, a global attribute like
    TextAlign), last writer wins. Canonical in the block's `attrs.cite`, **never in its
    `pm`** (stripped on the way out, ignored on the way in); stored trimmed and capped
    at `CITE_MAX_LENGTH` code points (`normalizeCite`), absent when blank. The editor
    field stores it as typed (trimming there would eat spaces mid-word).
  - Defaults left out = an untouched old image/quote stores only `version: 2` more.
  - The editor's views are `components/editor/extensions/BlockNodeViews.ts` (a plugin's
    `nodeViews` prop, so the schema extensions stay DOM-free); the view selects the image
    on mousedown (it isn't a leaf any more, so ProseMirror wouldn't).
  - **Stale clients:** an editor bundle from before #346 has no `imageCaption` type and
    no `align`/`cite` attrs: y-tiptap deletes the caption element (rule 10's uncovered
    case) and drops the attrs when it rewrites that node. Reload open admin tabs after
    deploying this.
  - Tests: `blockBridge.captionCite.test.ts`, `blocks-spec/captionCite.test.ts`,
    `components/editor/extensions/captionCite.collab.test.ts` (commands, keys, views, two
    users on the relay + stored `block_doc`); API side `TestSanitize_Image*` /
    `TestSanitize_BlockquoteCite`.
- **Block colour (#356): a palette token, never a free colour.** `blockColor` is a global
  attribute (`components/editor/extensions/BlockColor.ts`, in `schemaExtensions`, so the
  collab server's schema has it) on paragraph, heading, blockquote and both lists:
  `BLOCK_COLORS` (`blocks-spec`), a token for tinted text (`"red"`) or the same token with
  `-background` for a tinted block, **one or the other** (every theme only has to make each
  token readable as text on its page and under its own text as a fill; `tokens.test.ts` and
  `themes/default/tokens.test.ts` check 4.5:1). Canonical in the block's
  **`attrs.blockColor`** like a quote's `cite`, **never in its `pm`** (stripped on the way
  out, ignored on the way in), absent when untinted. `pmJSON` also leaves
  `"blockColor": null` out of every nested node: `toJSON` keeps null attrs, and without that
  every paragraph inside a list item, quote or theme block would change, so every stored
  post would change on its first store after #356 (pinned by
  `blockBridge.blockColor.test.tsx`). A nested colour (pasted from the editor's own HTML)
  stays in the pm and renders. A value outside the palette is dropped everywhere: HTML parse
  (`data-block-color` only, via `normalizeBlockColor`), the paste sanitizer (#128: kept only on
  block tags, only a palette value; inline styles never become a colour), the bridge, the
  validator (`z.enum`, never reached by the bridge's output), the API sanitizer
  (`sanitizeBlockColor`, any depth of the pm) and the renderer (`gl-color-<value>` classes,
  `blockColor.ts`). No block version bump: an older renderer ignores the attr. **Stale
  clients:** an editor bundle from before #356 has no `blockColor` attr; y-tiptap drops it
  when it rewrites that node. Reload open admin tabs after deploying this.
- **Block menu (#356, `components/editor/utils/blockActions.ts`, `ui/BlockMenu.tsx`,
  `ui/MoveToDialog.tsx`):** Duplicate (Ctrl D), Move to (Ctrl Shift P), Copy link to block,
  Colour, Delete, from the drag handle. Each is **one ProseMirror transaction, so one Yjs
  transaction** (collaborators see one move), and none is an appendTransaction (rule 7
  doesn't apply). Blocks are found **by block id when the action runs**, not by the position
  the menu opened at. **Ids are never copied:** Duplicate strips every `data-block-id` in the
  copy (`withoutBlockIds`) and BlockIdExtension stamps fresh ones (top-level and list items,
  #238) in the same transaction; Move (delete + insert) keeps the block's own id. Pinned by
  `blockActions.test.ts` and `blockActions.collab.test.ts` (two editors on the relay, ids
  unique in both and in the stored doc, one Yjs transaction, quiet afterwards). Copy link
  copies `<public post URL>#b-<block id>`: the public renderer puts `id="b-<id>"`
  (`blockAnchorId`) on every top-level block; a heading keeps its #351 slug and carries the
  anchor on an empty span, and `headingAnchors` never gives a heading a `b-<id>` slug.
- **Presence (#356):** clicking a collaborator's avatar calls `EditorRef.jumpToCollaborator`
  (`scrollToCollaborator` in `utils/cursorAwareness.ts`): it scrolls to the caret drawn for
  their awareness client (`data-client-id`), else to their awareness selection; it never
  moves this user's selection. The offline status says "Offline · N edits waiting" from the
  provider's `unsyncedChanges` (`useCollabPresence`'s `unsyncedCount`): memory only, rule 0.
- Heading levels are **1–6** (`HeadingBlock.level`, `zHeading`, the bridge, and the
  editor schema; keep them in sync). The server's store runs `validateBlockDoc` (#214)
  before writing `block_doc`. A **known** block type must match its own Zod schema; only
  unknown types use the custom catch-all. Both validators return the **input object**,
  never Zod's parse output (which strips keys the schemas don't list, e.g. list
  `children`). An image's `mediaId` must be a number (the API's media sync skips anything
  else).

## Theme blocks (#376)

A theme's custom block (`themes/<slug>/blocks/<Name>/`, contract in `themes/README.md`)
is a real block type for the editor, the collab server, the API and the public page.

- **Build-time only.** `lib/theme-blocks/installed.ts` globs every block's headless
  `index.ts` (`defineThemeBlock`: Block Spec + TipTap node, no React or DOM);
  `editorBlocks.ts` globs `editor.ts` (node view + slash entry) for the admin;
  `src/components/blocks/registry.ts` globs `render.tsx` for SSR. Vite resolves the globs
  for the admin, SSR and vitest; the collab bundle and the manifest generator use
  `collab-server/importMetaGlob.mjs`. Nothing imports a theme module by URL (the
  production web server can't serve TypeScript, #271). `themeBlocks.loadable.test.ts`
  fails on a block the production build can't load.
- **"Installed" = in this build, whichever theme is active.** The editor schema, the
  collab schema, the API manifest and the public renderer know every installed theme
  block, so a post keeps its blocks (and stays editable) when the site switches themes.
  Only the slash menu offers just the active theme's blocks (`ThemeContext`).
- **Namespacing (decision):** a theme block's type, which is also its ProseMirror node
  name and Yjs element name, is **`theme:<slug>/<block>`** (`THEME_BLOCK_TYPE`, e.g.
  `theme:example/alert`). No core type contains `:`, so a theme block can't collide with
  or shadow a core block, and two themes can't collide; `collectThemeBlocks` refuses a
  type outside its directory's theme or declared twice. A theme block is exactly one node
  whose content expression uses core types/groups only (`:` and `/` would break a
  ProseMirror content expression that named it).
- **Block Spec:** declared attrs (`string`/`number`/`boolean` scalars with `enum`,
  `maxLength`, `integer`, `minimum`, `maximum`; names may not be `pm`, `text`,
  `data-block-id` or `on*`) are **canonical on the block's `attrs`, never in its `pm`**
  (like a quote's `cite`): `pm` is `{type, content}`, plus `text`. `defineThemeBlock`
  builds the node's attrs from the spec and puts the spec on its NodeSpec
  (`glThemeBlock`), so the bridge (`themeNodeToBlock` / `themeBlockToPM`) and the store's
  `validateBlockDoc(doc, { themeBlocks: themeBlockLookup(schema) })` read it from the
  schema. The block's `version` is its spec's. A stored version **newer** than the build
  reads (written before a rollback) is treated like an uninstalled theme's block: dropped
  at seed (hidden, kept), not attr-checked by the store or the API (validating it against
  the older spec would refuse every store of the post), not rendered publicly. A set value
  the spec doesn't allow is left out in both directions (`declaredAttrs`), so it costs that
  attr (the default applies), never the post's store. Same rules in the API
  (`api/theme_blocks.go`, from the manifest); `blocks-spec/themeBlockVectors.json` is
  shared by both test suites.
- **Uninstalled theme (decision):** a `theme:` block whose theme isn't in the build (it
  was removed) is **never lost**: seeding drops it like any unbuildable block (#213), so
  it stays out of the Yjs doc, is kept byte for byte in `meta.dropped`, put back at its
  place by every store, and shown as a hidden block in the editor, whose other blocks stay
  editable. The API stores it unvalidated (generic sanitizer only); the public page
  renders nothing for it (`BlockRenderer`, logged once per type). Reinstalling the theme
  brings it back. An unknown type that isn't `theme:` (pre-#376 data such as `alert`)
  still gets a stand-in, as before.
- Mixed deploys: the editor, collab and api images must come from the same commit. A
  collab bundle with a block the editor lacks trips rule 10 (static read-only view); an
  editor with a block the collab bundle lacks has it stored through a stand-in, as a
  generic custom block.
- Tests: `blockBridge.themeBlocks.test.ts`, `schema.node.test.ts`,
  `lib/theme-blocks/themeBlocks.collab.test.ts` (two users on the relay, stored
  `block_doc`, restart), `themeBlocks.loadable.test.ts`, `blocks-spec/themeBlocks.test.ts`,
  `src/components/BlockRenderer.themeBlocks.test.tsx`, the bundle in
  `collab-server/process.test.ts`, Go `TestThemeBlock*`.

## How to test headlessly

- Bridge: build a schema with `getSchema([StarterKit, TextAlign, ImageWithMediaId,
  BlockIdExtension, …])` (see `blockBridge.test.ts`), or `getCoreSchema()`.
- Client ↔ server: `hocuspocusRelay.testkit.ts` runs the real collab server in-process
  with the #280 API faked in memory; `reconnect.hocuspocus.test.ts`, `liveRestore.test.ts`,
  `CollabSaveStatus.test.ts`, `Editor.test.tsx`, `accessChange.hocuspocus.test.ts` and the
  paste/BlockId collab tests use it. Its `clock` drives the server's access re-check
  (`await relay.clock.advance(RECHECK_MS)`); the re-check never fires on its own there.
  Under jsdom the clients use the provider's own `ws` (Node's and jsdom's WebSockets
  can't dispatch jsdom's `Event`). Its `restart()` terminates the sockets: Hocuspocus's
  `destroy()` leaves them open. Encode any newly found reconnect bug as a red test there.
- `reconnect.test.ts` models the same sequences at the pure CRDT level (two `Y.Doc`s and
  a stored state). **Caveat:** in-process tests run in ONE module system, so they can
  never reproduce the dual-instance hazard (rule 13). A green harness rules out CRDT
  logic, NOT the server's runtime environment; that is what the server's
  `process.test.ts` is for.

## Open follow-ups (don't "fix" silently)

- Server-side restore through `openDirectConnection` (#286).
- The block-map schema (#122) and block comments (#192) as `Y.Map`s keyed by block id.
