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
  `onAccess` / `getAccess()` / `readOnly` follow it. `onComments` (#192): the server's
  `{"type":"comments"}` nudge (the API wrote a comment on the post), read-only connections too;
  carries nothing, listeners refetch from the API. A revoke sets status `revoked`,
  disconnects for good (never handed out again by `acquireHocuspocus`) and **keeps the
  Y.Doc**; the next authentication (a reconnect) replaces any earlier access message. A post
  moved to the trash (#327) closes (or refuses at connect) with `post-trashed`: handled as a
  revoke with `trashed: true` in `getAccess()`, so `AccessNotice` says so and nobody is sent
  to sign in again. `schema-mismatch` (#416, rule 10) ends it too, with `outdated: true`:
  never retried, the editor asks for a reload. **A
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
- `schemaFingerprint.ts` (#416): `schemaFingerprint(schema)` (SHA-256 of
  `describeSchemaForFingerprint`, plain JS, the same in the browser and the server) and the
  auth token (`encodeCollabAuthToken` / `decodeCollabAuthToken`: the ticket plus the
  fingerprint, as JSON). Rule 10 says what it guards.
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
   throw. Pinned by `schemaGuard.test.ts` (the deletion itself + detection) and
   `Editor.test.tsx`.
   **A peer inserting a new type after this editor bound** (a tab still on the bundle from
   before a deploy) is covered by the **schema fingerprint guard (#416)**:
   `schemaFingerprint.ts` hashes what decides which docs a schema builds (node and mark
   names in schema order, content expressions, groups, allowed and excluded marks, attrs
   with defaults; not attr or key order, nor editing/rendering options: the full list is
   on `describeSchemaForFingerprint`). The client sends it with its ticket in the auth
   message (`encodeCollabAuthToken`, never the URL; `postCollab.ts` fingerprints the
   editor's own extension list, `schema.test.ts` proves it equals the server's), and the
   server refuses any other value, or none (a client from before #416), with
   **`schema-mismatch`**, before the access lookup and before the doc loads, so a refused
   client causes no write. The client never retries: `outdated` in `getAccess()`, status
   `outdated`, never handed out again by `acquireHocuspocus`; the editor shows "The editor
   was updated. Reload to keep editing." with Reload, over a static REST view (refused at
   connect) or the bound doc kept read-only (refused on a reconnect). A connection already
   open keeps going until it reconnects; a deploy's collab restart forces that, so a stale
   tab never syncs a type it can't build. **Every bundle from one commit must agree**: the
   editor, collab and api images come from the same commit (Theme blocks, below). Pinned
   by `schemaFingerprint.test.ts`, `schemaMismatch.hocuspocus.test.ts`, `Editor.test.tsx`,
   `collab-server/auth.test.ts` and the bundle's fingerprint in `process.test.ts`.

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
  bullet_list/ordered_list/listItem, callout/pullQuote/taskList/taskItem (#419), tableBlock (#420),
  video/audio/file (#423), embed (#425), buttons/spacer (#426) and every container, `CONTAINER_NODE_NAMES`). Custom/theme nodes must declare it too or
  `schema.nodeFromJSON` throws "Unsupported attribute".
- **Callout, pull quote, to-do list (#419, three flow blocks).** Schema in `schemaExtensions`
  (`components/editor/extensions/Callout.ts`, `PullQuote.ts`, `TodoList.ts`: TipTap's TaskList/
  TaskItem 3.4.2, `nested: false`), views in `BlockNodeViews.ts` (callout: icon + Type buttons
  while the cursor is in it; pull quote: the quote's citation field), TaskItem's own checkbox
  view (reverts a click when not editable). Each one's own attr is **canonical on the block,
  never in its `pm`**, like a quote's `cite`: `tone` (always written, `normalizeCalloutTone`:
  unknown → info), `cite` (`normalizeCite`), `checked` (a boolean, always written). The to-do
  list is a **third list type** (`LIST_ITEMS` in `nesting.ts`): `taskItem` is a block only in a
  `taskList` (`isBlockNode`), the bridge's list path builds `taskItem`s (a paragraph child is
  wrapped, a `list_item` child dropped and reported, an empty list gets one synthesized item,
  `<listId>-list-item`). **Stale clients:** a bundle from before #419 lacks the four node types;
  the fingerprint guard (#416) refuses it (`schemaFingerprint.test.ts` pins that each one changes
  the fingerprint). **Old data:** before #419 tests used `callout` as an unknown custom type
  (now `sidenote`); a stored pre-#376 custom block named `callout` now reads as the core callout
  (its inline content fails `paragraph+`, so it is dropped at seed and kept, #213). Tests:
  `blockBridge.textBlocks.test.ts`, `blocks-spec/textBlocks.test.ts`,
  `components/editor/extensions/textBlocks.test.ts` (commands, views, read-only, paste) and
  `textBlocks.collab.test.ts` (two users on the relay, the stored doc, a restart).
- **Containers (#414, `blocks-spec/nesting.ts`, design `docs/design/block-library.md` 2.1–2.11).**
  A container (Group, Details #421; columns, … later, each a row of the table) holds its
  child blocks **by id** in `children`, each a full block in the flat `blocks` map, like a
  list's items, and in the fragment it is one element with its children as elements (the
  content stays in the one `"default"` fragment, #315 Option C). The table drives everything:
  - **Schema:** a container is **not in TipTap's `block` group** (the quote's `block+`, the list
    item's `paragraph block*` and theme blocks name `block`, and a container there would hide
    its blocks inside that block's `pm`). The doc node is `GroupDocument` (`topLevelContent()`:
    `(block | group)+`; StarterKit's `document` is off in `schema.ts`) and a container's
    content is `containerContent(type)` (`block` = flow). Containers are `isolating` + `defining`.
  - **The block predicate `isBlockNode(node, parent)`** is the one rule for which nodes are
    blocks (parent is the doc, a container or a container's slot, or a list's item), used by
    `BlockIdExtension`, `stampFragmentBlockIds`, `pmToBlockDoc` and `stampBlockIds`. Ids are
    deduped across the whole doc at every depth, so a split inside a group, a duplicated group
    (#356) and a pasted group (#128) all get fresh ids. Rule 7 unchanged.
  - **Bridge:** `pmToBlockDoc` is recursive (a container becomes its block plus one block per
    child; a childless one is skipped). `containerChildrenToPM` builds and `check()`s each child
    on its own and requires a type the table allows; a bad one is dropped and reported with
    `parentId` = the container, `afterId` = its previous sibling. Too few children left →
    synthesized ones with **deterministic ids** (`synthesizedChildId`: `<containerId>-paragraph`).
    `containersInProgress` (the old `listsInProgress`) catches cycles for lists and containers;
    `referenced` drops a block at its second reference (two parents, or a parent and the top).
    `restoreDroppedBlocks` copies a subtree without children that are already in `current` (or
    missing from the source), so a restore never makes a block have two parents.
  - **Store:** `fragmentToBlockDoc` converts a container's children one at a time: an
    unconvertible child keeps its `previous` version under its container (`UnconvertibleBlock.
    parentId`); a container with no convertible child falls back as a whole. Then
    **`dedupeBlockRefs`** (repeats within one list, as the API's `deduplicateBlocks`) and
    `validateBlockDoc`, which now also runs `nestingIssues` (references exist, one parent each,
    no cycles, the table's types and counts, no `children` on core non-containers). The API runs
    the same checks; `blocks-spec/nestingVectors.json` pins both.
  - **Paste:** the containers are `data-pm-slice` contexts (attrs reset to null) and a group's
    `<div data-type="group" data-style data-align>` survives the sanitizer with valid values only.
  - **Stale clients:** an editor bundle from before #414 has no `group` type (and a `block+`
    doc), so y-tiptap would delete a group a newer peer inserts. The schema fingerprint guard
    (#416, rule 10) refuses such a tab with `schema-mismatch` before it syncs, and it reloads;
    `schemaFingerprint.test.ts` pins that Group changes the fingerprint.
  - Tests: `blocks-spec/nesting.test.ts` (vectors, table), `blockBridge.nesting.test.ts` (round
    trips, drops, synthesized ids, cycles, the store's per-child fallback),
    `components/editor/extensions/GroupBlock.test.ts` (commands, view, split/duplicate/paste ids)
    and `GroupBlock.collab.test.ts` (two users in one group on the relay, the stored doc).
- **Details (#421, `components/editor/extensions/DetailsBlock.ts`): the second container.** A
  row of the nesting table (`details`: flow only, 1+; a group may hold one) with a **part**:
  its content is `detailsSummary` then flow (`containerContent` puts a row's
  `parts` first). Our own node, not TipTap's Details extension (no `detailsContent` slot, no
  new package): its blocks sit right after the summary.
  - **The summary is a child node, never a block:** `detailsSummary` (`text*`, caption marks),
    no `data-block-id` (`isBlockNode` leaves parts out), `isolating` (Backspace never joins
    the first block into it) and not `selectable`. So two people typing in one summary merge
    per character. Block Spec `details` v1: `attrs.summary` its runs (like a caption's,
    `captionRuns` on the way in), `attrs.text` their text (search reads it), `attrs.open: true`
    or absent; `children` its blocks. The bridge's per-child type check starts after the
    parts (`afterParts`), and `fragmentToBlockDoc` falls a details back as a whole when no
    *block* in it converts (its summary alone doesn't count, or it would be skipped and lost).
  - **`open` ("Open by default")** is a node attr, last writer wins (the view's switch, the
    Block tab, `setDetailsOpen`); the editor always shows the blocks.
  - **Keys** (`DetailsKeyboard`, editor only, priority 200, no appendTransaction): ↵ in the
    summary moves into the content (the first block's start, or a new empty paragraph above a
    block that isn't text; the summary never splits); ⌫ at the summary's start does nothing
    (TipTap's own Backspace would try to clear it into a paragraph) except in an empty details,
    which it removes; ⌫ at the first block's start goes back to the summary. #417's keys need
    nothing: the summary isn't an editor block, so Esc there selects the details and ↵ on it
    steps into its first block.
  - **Paste:** `normalizeClipboardMarkup` turns a page's `<details [open]><summary>` into the
    editor's `<div data-type="details" data-open="true"><div data-type="details-summary">`
    before DOMPurify, which keeps those `data-type`s and `data-open="true"` only there.
  - **Stale clients:** a bundle from before #421 has no details nodes (and a doc and group that
    don't name it); the fingerprint guard (#416) refuses such a tab (`schemaFingerprint.test.ts`).
  - Tests: `blockBridge.details.test.ts`, `DetailsBlock.test.ts` (schema, commands, keys, view,
    paste, ids), `DetailsBlock.collab.test.ts` (two users in one summary, the stored doc, a
    restart), the #414 vectors, `comments.hocuspocus.test.ts` / `blockEdits.hocuspocus.test.ts`
    (threads and "Last edited by" on blocks in a details; a summary edit is the details'),
    `src/components/blocks/details/DetailsBlock.test.tsx`, Go `post_blocks_details_test.go`.
- **Gallery (#424, `components/editor/extensions/GalleryBlock.ts`): the third container.** A row of
  the nesting table (`gallery`: `image` only, 0+, top level only) whose part comes **last**
  (`partsLast`: `image* galleryCaption`), so the caret walks images, then caption, as a reader sees
  them.
  - **The children are ordinary image blocks** (image v2: alt, caption, media id, each with its own
    id), so "Used in", media attachment, the sanitizer and the renderer need nothing new.
  - **The caption is a child node, never a block:** `galleryCaption` (`text*`, caption marks), no
    `data-block-id`, always the last child (empty = none). Block Spec: `attrs.caption` runs, like an
    image's (search reads `caption` runs already). `columns` (2–4, `normalizeGalleryColumns`, always
    written) is a node attribute, last writer wins.
  - **It may be empty** (`min: 0`, so `synthesize` is optional): the bridge keeps it, `pmToBlockDoc`
    doesn't skip it, nothing is synthesized or dropped. `fragmentToBlockDoc` still falls a gallery
    back as a whole when it **had** images and none built: that isn't an empty one.
  - **Reorder** is `moveGalleryImage` (`utils/galleryActions.ts`): #417's `planBlockMove` plus
    `applyBlockMove`, one Yjs transaction, id kept, from the keys, a tile's buttons and a drag
    (`gutterPlugin`: among images a drop is left or right, the line upright). **Adding** several is
    one transaction (`addGalleryImages`, from the picker's multi-select or an upload). Removing the
    last image leaves the gallery (`removalRange`: the schema allows it).
  - **The panel's caption field** (`ui/GallerySettings.tsx`) edits the image's `imageCaption` by
    **the characters that changed** (`imageCaptionTr`), so a field in the panel merges per character
    like the caption itself and keeps marks on the rest. The field always shows the doc's value
    (`SyncedField`): it compares what's typed with what the post says now, never with a stale copy.
    Alt text is an attribute, last writer wins, flagged per image (`galleryImageMissingAlt`).
  - **Keys** (`GalleryKeyboard.ts`, editor only, priority 200, no appendTransaction): ← → between
    images, ⌘⇧← → reorder, ↵ on a selected image opens the Block tab with focus in its alt text
    (`requestGalleryAltFocus`), ↵ in the gallery's caption goes under the gallery, ↵ in an image's
    caption back to the image (ImageCaption's own Enter would put a paragraph in the gallery), ⌫ never
    deletes the caption on its own. The tile's Move and Remove are `data-block-toolbar`, so #417's Tab
    reaches them; a gallery image has no + (only images go in a gallery, through Add images).
  - **Paste:** `div[data-type=gallery][data-columns]` and its caption survive with valid values only;
    images are dropped as everywhere, so a pasted gallery has its caption and no images.
  - **Stale clients:** a bundle from before #424 has no gallery nodes (and a narrower doc); the
    fingerprint guard (#416) refuses such a tab (`schemaFingerprint.test.ts`).
  - Tests: `blockBridge.gallery.test.ts`, `extensions/GalleryBlock.test.ts` (commands, keys, views,
    missing media per image, the caption field, paste), `extensions/GalleryBlock.collab.test.ts` (two
    users on the relay: a keyboard and a drag reorder each one Yjs transaction, concurrent reorder and
    captioning, several images added at once, every image removed, a restart),
    `ui/GallerySettings.test.tsx` (per-image alt flags), `utils/blockTree.test.ts` (the drop),
    `src/components/blocks/gallery/GalleryBlock.test.tsx`, Go `post_blocks_gallery_test.go`, and six
    cases in `nestingVectors.json`.
- **Table (#420, `components/editor/extensions/TableBlock.ts`): a flow block, not a container.**
  The block node is `tableBlock` (`table tableCaption`, `BLOCK_NODE_NAMES.table`): TipTap's
  `table` (prosemirror-tables reads every child of `table` as a row, so the caption can't live
  there) plus a caption that is always there (empty = none). Cells are **`paragraph+`** and their
  only attrs are `colspan`/`rowspan` (no `colwidth`, no resizing). `tableBlock` is **not in the
  `block` group** (`STANDALONE_FLOW_NODE_NAMES` in `nesting.ts`): the doc and flow containers
  name it, so a table is never part of a quote's, a list item's or a theme block's `pm` (paste
  lifts it out; `slotAcceptsAt` doesn't offer it there).
  - **The header row is the grid's `headerRow` attr, never a cell type.** There is no
    `tableHeader` node: every cell is a `tableCell`. Toggling the header row is one attribute
    (last writer wins); a cell whose node type changed would be a new Yjs element, and a peer
    typing in it would lose those keys (`TableBlock.collab.test.ts` pins it). The editor
    styles the row from `data-header-row` (`GridView`); the public page renders `<thead>`.
  - **Block Spec `table` v1:** `attrs.pm` = the `table` node's rows (no attrs; every cell a
    `tableCell`, spans only when not 1; a row may be empty when a rowspan covers it),
    `attrs.headerRow` (`true` or absent) from the grid's attr, `attrs.caption` runs like an
    image's, `attrs.text` the cell texts. On load `tableRows` keeps only rows, cells and
    paragraphs (a stored `tableHeader` is read as a cell), spans clamped to `TABLE_MAX_SPAN`. A
    table with no rows can't be built: dropped and kept (#213). No `children`.
  - **Rule 7:** prosemirror-tables' `tableEditing` plugin has an `appendTransaction`
    (`fixTables` pads short rows). `GlTable` wraps it to skip collaboration-sync transactions,
    or every peer would pad a table two people reshaped at once and each padding would sync;
    only a local change fixes a table (`TableBlock.collab.test.ts` fails without the guard).
  - **One transaction each:** `insertTableBlock` (after a selected block, or for the caret's
    line), `addTableRow`/`addTableColumn`, `deleteTableRow`/`deleteTableColumn` (never the last
    one: prosemirror-tables only refuses that when dispatching, so `can()` is checked first),
    `toggleTableHeaderRow`.
  - **Keys** (`TableKeyboard`, editor only, priority 200): Tab / ⇧Tab between cells, Tab in the
    last cell adds a row, ⌥F10 focuses the toolbar, Backspace with every cell selected deletes the
    table block. **Only while the caret is in a cell**; anywhere else they return false, so lists,
    the gutter's Tab and #417's keys run as before.
  - **Paste:** `PasteSanitizer` keeps `td`/`th` (with clamped `colspan`/`rowspan`), turns each
    cell's content into paragraphs (`flattenCell`: a heading, a list item or a nested table's
    cell ends a line), and moves a `<caption>` into the figure's `figcaption`. A pasted table
    has a header row when its first row is all `<th>` (`hasHeaderRowHTML`); any `<th>` is a
    plain cell. A table pasted with the caret in a cell fills cells from there
    (`pastedIntoCell`, `TableKeyboard`'s `transformPasted`) instead of splitting the table.
  - **Stale clients:** a bundle from before #420 has no table nodes (and a narrower doc), so
    y-tiptap would delete a table a newer peer inserts; the fingerprint guard (#416) refuses
    such a tab (`schemaFingerprint.test.ts` pins that the table changed it).
  - Tests: `blockBridge.table.test.ts` (bridge, fragment, Zod), `TableBlock.test.ts` (commands,
    keys, picker, toolbar, paste), `TableBlock.collab.test.ts` (two users in different cells; a
    column and a row at once), `src/components/blocks/table/TableBlock.test.tsx`, Go
    `post_blocks_table_test.go`, and two cases in `nestingVectors.json`.
- **Columns, buttons, spacer (#426, `components/editor/extensions/ColumnsBlock.ts`, `ButtonsBlock.ts`,
  `SpacerBlock.ts`; rules `blocks-spec/layoutBlocks.ts`).** Columns are two rows of the table (`columns`,
  `column`; a group may hold columns, a column flow and details, never a group).
  - **The 2–4 limit is not in the content expression (`column+`, `countNotInSchema`).** y-tiptap's
    `createNodeFromYElement` uses `schema.node()`, which is `createChecked`: it **deletes** an element
    whose children fail the content check, for every peer. With `column{2,4}`, two people adding a
    fourth column at once would delete the whole row, and the group around it
    (`LayoutBlocks.collab.test.ts` found it). So the schema allows any count of columns and the
    limit lives in the table: `nestingIssues` and Go refuse a stored doc outside it, `blockTree.ts`'s
    `withChildren` and the commands keep local changes inside it, and the collab server's store runs
    `repairColumnsFragment` first (a fifth column's blocks move to the fourth, one column gets an empty
    one beside it, an empty column an empty paragraph), origin `SERVER_ORIGIN`, like stamping ids.
    **Any new limit two people can break at once must do the same.**
  - **A removed column's blocks are never deleted** (`utils/columnActions.ts`, `setColumnCount`): they
    move, with their ids, to the end of the last column that stays, as one move through
    `applyBlockMove` (so two people removing the same column get two copies, never a loss).
    Only empty paragraphs aren't carried over. A column's last block deleted or moved away leaves
    an empty line (`fillWhenEmptied`); deleting a selected column is the ordinary block delete.
  - **Buttons are parts, kept in `pm`** (`button` nodes, no ids: `isBlockNode`). `href` is a node attr,
    so nothing else checks it: `normalizeButtonHref` in the bridge (both ways), the node's HTML, the
    command and the paste sanitizer, `isSafeURL` in Go, and the renderer again. `buttonHrefVectors.json`
    pins that the editor and the API agree. A peer's bad Yjs update costs the link, never the store.
    The editor never renders a live `<a>` for one.
  - **The spacer's `size` is a step of the theme's scale** (`SPACER_STEPS`), never pixels; one
    `setSpacerSize` per step, last writer wins.
  - **Stale clients:** a bundle from before #426 lacks the five node types (and a narrower doc, group,
    details and column), so the fingerprint guard (#416) refuses it (`schemaFingerprint.test.ts`).
  - Tests: `blockBridge.layout.test.ts`, `extensions/LayoutBlocks.test.ts`, `LayoutBlocks.collab.test.ts`
    (four users in a tinted group of three columns, concurrent adds and removals, a restart),
    `blocks-spec/layoutBlocks.test.ts`, `src/components/blocks/layoutBlocks.test.tsx`,
    `themes/default/layoutBlocks.test.ts`, Go `post_blocks_layout_test.go`, cases in `nestingVectors.json`.
- **Cover and media & text (#427, `components/editor/extensions/CoverMediaBlocks.ts`, views `CoverMediaViews.ts`,
  panel `ui/CoverMediaSettings.tsx`, rules `blocks-spec/coverMedia.ts`).** Two rows of the table: `cover`
  (flow, top level only) and `media_text` (flow and details, top level or in a group). The image is
  `mediaId` alone, like a video's; attrs are last writer wins.
  - **`focalX` and `focalY` are two scalars, never one object:** y-tiptap compares attributes by
    identity, so an object attr would be written to the shared doc on every sync of the node. In Block
    Spec they are one `focal`, both or neither. A block has one only after someone moved it; until then
    it follows the media's `focal_point`.
  - **An empty one is valid in the schema (`*`, `emptyNotInSchema`), though the table says 1+.** The
    #426 rule: y-tiptap deletes an element whose children fail the content check, so two people
    deleting the last two blocks at once would delete the cover and its image for every peer
    (`CoverMedia.collab.test.ts`). The store runs `repairEmptyContainers` before stamping ids; a
    local change that empties one gets its line back from `EmptyContainerFill` (rule 7: not on a sync).
    The block delete and a move out already leave a line (`fillWhenEmptied`).
  - **Choosing an image** resets `focalX`/`focalY` and takes its alt text (`applyMediaToBlock`); a
    cover keeps its Decorative switch (default on), media & text follows the media's.
  - **Paste** keeps the type, overlay, align and position; the image doesn't paste (media comes from
    the library), so a pasted one shows its empty state with its text.
  - **Stale clients:** a bundle from before #427 lacks both nodes (and a narrower doc and group); the
    fingerprint guard (#416) refuses it (`schemaFingerprint.test.ts`).
  - Tests: `blockBridge.coverMedia.test.ts`, `extensions/CoverMedia.test.ts`, `CoverMedia.collab.test.ts`
    (two users, the merge that empties one, a restart), `ui/CoverMediaSettings.test.tsx` (the focal
    point's keys), `blocks-spec/coverMedia.test.ts`, `src/components/blocks/coverMedia.test.tsx`,
    `themes/default/coverBlocks.test.ts`, Go `post_blocks_cover_test.go`, cases in `nestingVectors.json`.
- **Inline marks highlight, superscript, subscript (#418, `components/editor/extensions/InlineMarks.ts`).**
  TipTap's Highlight (`multicolor: false`: **no `color` attr**, one theme colour), Superscript
  and Subscript 3.4.2, in `schemaExtensions`. Superscript and subscript **exclude each other**
  (`excludes`, each also itself), so neither builds without the other. Block Spec keeps them as
  runs with no attrs (`{type:"highlight"}`); captions don't allow them (`CAPTION_MARKS`).
  ⌘⇧H is Highlight's own shortcut; ⌘. and ⌘, are exact (`exactShortcut`: no Shift, so ⌘⇧, stays
  #417's settings panel; ProseMirror's keymap would retry a shifted `,` without Shift; a
  non-ASCII key there, Cyrillic or Greek, matches by `keyCode` as the keymap would).
  Highlight has no `==text==` input or paste rule (not one of the Markdown shortcuts, and it
  would highlight pasted `a == b == c`).
  - **Concurrent excluded marks:** Yjs keeps each formatting attribute on its own, so two people
    setting superscript and subscript on one word at once (or bold and inline code, which
    excludes every mark) leave a run with both. y-tiptap builds it unchecked (the editors show
    both), but `check()` refuses that set, so unhandled the next seed would hide the whole block
    (#213). **`withoutExcludedMarks` / `withValidMarkSets` (`blockBridge.ts`) resolve it as
    `Mark.addToSet` would, in rank order** (subscript wins over superscript, code over the rest):
    in `pmJSON` (every store) and before each block's `nodeFromJSON` + `check()` at seed.
  - **API allowlist:** the Go sanitizer keeps only `allowedMarkTypes` (every mark of this
    schema), drops any other mark (the text stays) and every attr but a link's;
    `blocks-spec/markAllowlist.test.ts` fails if the list and the schema's marks differ. **A new
    mark needs an entry there.**
  - **Stale clients:** a bundle from before #418 lacks the three marks, and y-tiptap would delete
    a highlighted run a newer peer typed (rule 10); the fingerprint guard (#416) refuses it
    (`schemaFingerprint.test.ts` pins that they, their exclusions and a colour attr change it).
  - **Old tests:** `highlight` used to stand for an unknown theme mark; such tests use `spoiler`.
  - Tests: `extensions/InlineMarks.test.ts` (schema, shortcuts, exclusion, captions, HTML, round
    trip, paste), `InlineMarks.collab.test.ts` (two users on the relay, the stored doc, a seed with
    both marks, a restart), `ui/BubbleMenu.test.tsx`, `src/components/blocks/utils/
    contentRenderer.marks.test.tsx`, `themes/default/inlineMarks.test.ts`, Go
    `post_blocks_marks_test.go`.
- **Video, audio, file (#423, `components/editor/extensions/MediaBlocks.ts`): flow blocks, not in
  the `block` group** (`STANDALONE_FLOW_NODE_NAMES`, like the table: a block of the doc or a group,
  never part of a quote's or a list item's pm, which the page renders as text). Block Spec `video` /
  `audio` v1: `mediaId` and `caption` (the **image's caption node**, `imageCaption`, as their
  optional child: one node, one set of keys and bridge code; its parse rule's context is
  `image/|video/|audio/`); `file` v1: `mediaId` and `label` (a node attr typed in the view's field,
  last writer wins, stored as typed and normalized by the bridge, `normalizeFileLabel`). **No `src`,
  name or size is stored**: the media library has them (the editor looks them up, the public page
  reads the API's `media` map), so a replaced or deleted file shows as such everywhere and files are
  served only from `/uploads`. The bridge keeps only a positive integer `mediaId` (a numeric string
  is read as one) and a valid label, and leaves defaults out. `file` is an atom. The commands
  (`insertMediaBlock`, `setBlockMedia`, `toggleMediaCaption`) are `MediaBlockCommands` in
  `schemaExtensions` (no schema). Every change is one ordinary transaction from the user's own
  input; the views have no appendTransaction (rule 7). **Stale clients:** a bundle from before #423
  has none of the three nodes (and a narrower doc and group), so the fingerprint guard (#416)
  refuses it (`schemaFingerprint.test.ts`). Tests: `blockBridge.media.test.ts`,
  `components/editor/extensions/MediaBlocks.test.ts` (views, picker, upload, missing, read-only),
  `MediaBlocks.collab.test.ts` (two users, the stored doc, a restart), the public
  `src/components/blocks/mediaBlocks.test.tsx`, Go `post_blocks_media_blocks_test.go` and two cases
  in `nestingVectors.json`.
- **Embed (#425, `components/editor/extensions/EmbedBlock.ts`): a flow block, not in the `block`
  group** (`STANDALONE_FLOW_NODE_NAMES`, like the media blocks). Block Spec `embed` v1: `provider`, `ref`
  and `title`, node attrs, last writer wins (`embedStoredAttrs` on the way in and out: a known
  provider, a ref valid for it, a title that is plain text), and the image's caption node as its
  optional child. A provider with no ref is an empty block; the menu entry it came from set the
  provider. **Never in the doc:** HTML from a provider, a pasted URL, or whether someone opened the
  player (`loaded` is the view's own state, so no peer loads anything). The link is resolved by `POST
  /embeds/resolve` and applied in one transaction, the block found again by id (`embedLinks.ts`).
  Views (`EmbedBlockViews.ts`) have no appendTransaction (rule 7). **Stale clients:** a bundle from
  before #425 has no `embed` node (and a narrower doc and group); the fingerprint guard (#416) refuses
  it (`schemaFingerprint.test.ts`). Tests: `blockBridge.embed.test.ts`, `EmbedBlock.test.ts`,
  `EmbedBlock.collab.test.ts`, `blocks-spec/embeds.test.ts`, the public
  `src/components/blocks/embed/EmbedBlock.test.tsx`, Go `embeds_test.go` and two cases in
  `nestingVectors.json`.
- **Inline nodes (#320, `components/editor/extensions/InlineNodes.ts`, rules in
  `blocks-spec/inlineNodes.ts`): `mention` {userId, label}, `contentLink` {postId, label},
  `dateChip` {date, time, reminder}.** Inline **atoms** in the `inline` group, so they live in a
  text block's `pm` (paragraph, heading, list item, quote, pull quote, table cell; never a
  caption, which is `text*`) and no block type or version changed. The bridge needed nothing:
  they round-trip as pm JSON, and `leafText` (via `extendNodeSchema`) makes `textContent`, so a
  block's `text` and search read "@Ana Costa", the link text, the date. Views (the member's
  **current** name from `lib/mentionNames.ts`, the site's date format, a bell for a reminder)
  are `InlineNodeViews.ts`; the @ menu is `ui/MentionMenu.tsx`, the date dialog
  `ui/DateChipDialog.ts`. What they store, and why the public API rewrites them, is the header
  of `inlineNodes.ts`.
  - **Never in the doc:** a URL (the API resolves the target's current one), an email, or a
    reminder's owner (the API takes it from the store's per-block attribution, #328, which a
    client can't forge). Memory only for the names (rule 0).
  - **Marks on them don't survive Yjs:** y-tiptap 3.0.0 stores marks on text only, so a bold
    mention is bold only in the editor that made it; every peer and the stored doc have the
    plain node. Nothing else is lost and nothing loops (pinned in `InlineNodes.test.ts`).
  - **Paste:** `<span data-type="mention|content-link|date">` survives the sanitizer only with
    a valid id or date, each `data-*` only on its own type and normalized; every other span is
    still unwrapped (`uponSanitizeElement`).
  - **Stale clients:** a bundle from before #320 lacks the three types; the fingerprint guard
    (#416) refuses it (`schemaFingerprint.test.ts` pins each one, and the date chip's attrs).
  - Tests: `InlineNodes.test.ts` (bridge, fragment, commands, clipboard, paste),
    `InlineNodes.collab.test.ts` (two users on the relay, the stored doc, attribution, a
    restart), `blocks-spec/inlineNodes.test.ts` (the vectors shared with Go),
    `ui/MentionMenu.test.tsx`, `src/components/blocks/utils/inlineNodes.test.tsx`.
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
- **Cycles:** `listItemsToPM` and `containerChildrenToPM` track the lists and containers
  being converted. One that (directly or through another) contains itself throws at the
  child that closes the cycle, so that child is dropped and reported like any other bad child.
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
    no `align`/`cite` attrs: y-tiptap deletes the caption element (the case #416's
    fingerprint guard now covers) and drops the attrs when it rewrites that node. Before
    #416 that meant reloading open admin tabs after the deploy; now the stale tabs are
    refused at their reconnect.
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
  when it rewrites that node (reload open tabs after deploying; since #416 the guard refuses
  such tabs at their reconnect).
- **Block menu (#356, `components/editor/utils/blockActions.ts`, `ui/BlockMenu.tsx`,
  `ui/MoveToDialog.tsx`):** Duplicate (Ctrl D), Move to (Ctrl Shift P), Copy link to block,
  Colour, Delete, from the drag handle. Each is **one ProseMirror transaction, so one Yjs
  transaction** (collaborators see one move), and none is an appendTransaction (rule 7
  doesn't apply). Since #417 they act on the block at any depth, and Move to goes through
  `applyBlockMove` (below). Blocks are found **by block id when the action runs**, not by the position
  the menu opened at. **Ids are never copied:** Duplicate strips every `data-block-id` in the
  copy (`withoutBlockIds`) and BlockIdExtension stamps fresh ones (top-level and list items,
  #238) in the same transaction; Move (delete + insert) keeps the block's own id. Pinned by
  `blockActions.test.ts` and `blockActions.collab.test.ts` (two editors on the relay, ids
  unique in both and in the stored doc, one Yjs transaction, quiet afterwards). Copy link
  copies `<public post URL>#b-<block id>`: the public renderer puts `id="b-<id>"`
  (`blockAnchorId`) on every top-level block; a heading keeps its #351 slug and carries the
  anchor on an empty span, and `headingAnchors` never gives a heading a `b-<id>` slug.
- **Nested blocks in the editor (#417, design `docs/design/block-library.md` 3.5):** the
  block menu, the gutter, the keyboard and drops act on a block **at any depth**
  (`components/editor/utils/blockTree.ts`: an "editor block" is `isBlockNode` without list
  items, so a list stays one block). A move is one ProseMirror transaction (`planBlockMove`:
  insert the same node, so its id and every descendant's come along, then remove the
  original, with a container it leaves empty), checked against the nesting table
  (`dropTargetFor`: no group in a group, never inside itself; the nearest allowed place
  up the tree). **Moves reach Yjs through `applyBlockMove` (`utils/blockMoveSync.ts`),
  never a plain dispatch:** y-tiptap 3.0.0's `updateYFragment` matches children only from
  both ends and rewrites every same-type element in between *in place*, so a reorder became
  "rewrite gamma's element as end and end's as gamma", and a collaborator's concurrent move
  of gamma deleted "end" (pinned by `blockMoves.collab.test.ts`). `applyBlockMove` syncs the
  doc with only the removal, then the result, inside one Yjs transaction under the
  binding's mutex: a delete and an insert, one update for collaborators, one undo stack item
  (closed on both sides). Two people moving the same block at once get two copies, which the
  server's `stampFragmentBlockIds` gives distinct ids (design 2.12). It uses y-tiptap's
  binding internals (`mux`, `_prosemirrorChanged`): re-check it when bumping y-tiptap.
  **`extensions/NodeSelectionGuard.ts`:** y-tiptap restores a saved NodeSelection with
  `NodeSelection.create`, which throws inside the binding's Yjs observer when the selected
  block was deleted and was the last in its container (a collaborator's delete, or an undo
  right after a drop), so the editor would miss that change. Before the observers run
  (`beforeObserverCalls`) the guard turns that saved selection into a caret; a block that's
  still there stays selected. Neither adds an appendTransaction (rule 7).
- **Presence (#356):** clicking a collaborator's avatar calls `EditorRef.jumpToCollaborator`
  (`scrollToCollaborator` in `utils/cursorAwareness.ts`): it scrolls to the caret drawn for
  their awareness client (`data-client-id`), else to their awareness selection; it never
  moves this user's selection. The offline status says "Offline · N edits waiting" from the
  provider's `unsyncedChanges` (`useCollabPresence`'s `unsyncedCount`): memory only, rule 0.
  Inside nested blocks (#417): `placeCaretLabels` flips a label to the caret's left when it
  would overflow its container (`data-collab-bounds`, the group's view) or the editor, and
  stacks labels on one spot; a remote selection that is exactly one block is drawn as an
  outline in their colour with their name (`.collab-block-selection`), not a tint; colours
  pass `safeCaretColor` (hex only: awareness is any collaborator's to set). No container
  sets `overflow`, so nothing clips a label.
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
- Block-keyed features: decided in `docs/design/block-map-yjs-schema.md` (#315). The
  `"default"` fragment stays the only source of content; no block-map binding. Block comments
  (#192) are built that way: Postgres rows keyed by block id, and the only collab part is the
  stateless `{"type":"comments"}` nudge (`onComments`; nothing in the doc). Per-block attribution
  (#328) is built the same way: the server's block change tracker (`collab-server/blockEdits.ts`,
  read-only on the doc) sends who changed which block with each store that writes `block_doc`,
  the API keeps it in `post_block_edits`, and the `stored` message's `edits` reach open editors
  (`lib/blockEditsStore.ts`). Nothing in the doc, `block_doc` or a version.
