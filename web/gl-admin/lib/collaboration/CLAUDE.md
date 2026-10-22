# Collaboration / editor — agent context (READ BEFORE EDITING)

This is the **most sensitive subsystem in the codebase**. It has bitten us repeatedly
with data-loss and feedback-loop bugs. It now has real test coverage — keep it green
and add to it. Run `npm test` from `web/` after any change here.

## ⚠️ The 2026-06 data-loss saga: resolved (read this first)

The recurring "heartbeat" (content/images erased by autosaves with no typing, worse on
every save+reload) was a **stack of five real bugs**, fixed on PR #204. The decisive
root cause was **server-side: a dual yjs instance (ESM+CJS double-load)** in
`websocket/` — see the top gotcha in `websocket/CLAUDE.md`. The other four were real
and remain guarded by the hard rules below: client IndexedDB cache divergence (rule 0),
the BlockId remote-update feedback loop (rule 7), duplicate `data-block-id`s on
block-split, and client/server yjs version skew (rule 8). Debugging lesson: the
browser-side symptom (server reasserting a frozen state every 2s = `resyncInterval`)
pointed at the *server* long before the cause was found, and the yjs warning
"Yjs was already imported" had been printed at every server boot — **read process logs
from the very top**.

## The big mental model: TWO separate Yjs structures

A post's `Y.Doc` (keyed `post-<id>`) holds **two independent shared types**:

1. **The `"default"` XmlFragment** — the editor content. The TipTap **Collaboration**
   extension binds the editor to this (`Collaboration.configure({ document })` with no
   `field` option = fragment name `"default"`). **It is NOT named `"prosemirror"`** —
   code inspecting `getXmlFragment("prosemirror")` reads an always-empty fragment (this
   bug made all debug fingerprints useless during the saga's early diagnosis).
2. **`blocks` + `blocks_order` Y.Maps** — the **Block Spec v1 mirror**, managed by
   `BlockDocManager`. This is a *derived* representation used for persistence + SSR.

These are NOT automatically linked. The editor renders from (1); persistence saves (2).
A change in (1) only reaches (2) when something **mirrors** it (`pmToBlockDoc` →
`setBlockDocV1`). Most bugs here come from confusing the two or from the mirror.

## Files

- `CollaborationProvider.ts` — per-post singleton: `Y.Doc` + `WebsocketProvider`
  (`ws://…:1234`, `resyncInterval: 2000`). Ref-counted; destroyed 750ms after last
  release. **`resyncInterval: 2000` = the "2s" cadence** you'll see in any heartbeat-style
  bug. **NO client-side `IndexeddbPersistence`** — it was removed deliberately (see rule
  0). The WS server's LevelDB is the single live Yjs store; `whenSynced` is now a resolved
  promise kept only for API symmetry. **Never put the access token in the socket URL
  (#233):** proxy logs record it. The provider passes `WebSocketPolyfill:
  createTicketedWebSocket(...)` (`ticketSocket.ts`), which fetches a single-use, 30s,
  doc-bound ticket (`createCollabTicket` → `POST /collab/tickets`) before every connect
  and reconnect, then opens the real socket with `?ticket=`. A failed ticket fetch is
  reported as error + close, so y-websocket's normal backoff retries it.
- `BlockDocManager.ts` — CRUD over the `blocks`/`blocks_order` maps. `setBlockDocV1` is
  **incremental** (diff/upsert) — see below.
- `BlockPersistenceManager.ts` — the autosave **state machine**. The brains; most
  invariants live here.
- `blockBridge.ts` — `pmToBlockDoc` / `blockDocToPM`. Pure conversion.
- `schema.ts` (#206 P0) — `schemaExtensions()`: the schema-defining extensions, configured
  as the editor configures them, with no DOM or React. `components/editor/utils/extensions.ts`
  builds its list from them, so **change editor schema config there, not in extensions.ts**.
  `getCoreSchema()` builds the schema in plain Node (`schema.node.test.ts`), and
  `schema.test.ts` fails if the editor's schema and the core schema ever differ.
  `schemaWithStandIns(base, pmJson[])` adds a permissive stand-in node for every unknown
  (theme) type in the JSON, keeping its attrs, because the server can't load theme
  extensions (they import React NodeViews).
- `fragmentBridge.ts` (#206 P0) — `seedFragment` / `fragmentToBlockDoc`: Block Spec v1 ⇄ the
  `"default"` XmlFragment with no editor, for the Hocuspocus server. Same bridge, same
  schema, plus stand-ins, so theme blocks survive. Seeding returns `DroppedBlocks` (entries
  **and** their block trees); the server must keep that record and pass it to every store,
  or the blocks the editor can't show (#213) are deleted. Not wired into anything yet.
  `fragmentBridge.test.ts` (plain Node) and `fragmentBridge.editor.test.ts` (editors bound to
  a server-seeded doc: they show it, don't churn it, and their edits come back out).
- `debug.ts` — gated logging. Enable in browser: `localStorage.setItem("GL_DEBUG_COLLAB","1")`.
  Server side: `COLLAB_DEBUG=1`. Both are timestamped (`t=…`) so client+server logs align.

**Read-only editor (`readOnly` prop, used for contributors since #216):** creates no
`CollaborationProvider` and no `BlockPersistenceManager`. A dedicated effect in
`Editor.tsx` loads the REST working copy (`getPostBlocks` → `setEditorBlockDoc`, the
render helper in `blockBridge.ts` shared with `BlockPersistenceManager.initialize`). The
loaded guard is keyed by editor instance + postId, and a failed load (e.g. 401) retries
when `authManager` notifies about a refreshed token. No Yjs is involved, so the seeding
rules below don't apply to it. `PostForm` re-reads the role from `/users/me` before
mounting the editor, because the role cached at login can be stale. The WS server rejects
non-editors anyway (see `websocket/CLAUDE.md` → Auth).

## Hard rules (violating these reintroduces shipped bugs)

0. **Do NOT reintroduce client-side `IndexeddbPersistence` (or any client cache that
   survives reloads).** The WS server (LevelDB) is the **single source of truth** for the
   live Yjs state; Postgres `posts.block_doc` is the durable backup. A local Yjs cache
   inevitably builds a *different struct history* for the same content than the server's
   rebuilt doc; the two never converge, the 2s resync keeps applying "differences" (each a
   PM transaction → a spurious autosave with no typing), and it **compounds every reload**
   (the recurring "heartbeat" that erased text/images and "got worse each reload"). On
   open, the editor loads purely from the server. Removed in the IndexedDB-removal commit.

1. **Autosave is driven ONLY by `notifyEditorChange()`** (called from
   `editor.on("update")` in `Editor.tsx`). **Do NOT subscribe an autosave trigger to
   `BlockDocManager.onDocumentChange` (the old `handleDocumentChange`).** Doing so
   created the **WS-restart "heartbeat" loop**: performSave mirrors editor→maps, that
   syncs to the server, the server echoes it back on the 2s resync, the echo fired the
   map observer → another save → forever (revision climbing every 2s, content erased).
   Editor `update` already covers local *and* remote edits (the collab plugin applies
   remote changes as editor transactions).

2. **`setBlockDocV1` must stay incremental** (delete-gone / upsert-changed-in-place /
   replace-order-only-if-different). It used to `clear()` + recreate every block as a
   new `Y.Map` on every save — huge Yjs churn that fed the loop above. Identical content
   must produce **zero** Yjs mutations (a no-op save emits nothing). Don't revert it.

3. **`initialize()` is idempotent on success only.** It sets `hasInitialized=true` only
   after a successful load and releases `isInitializing` in a `finally`. A failed load
   (e.g. 401) must remain retryable and must NOT permanently disable autosave.

3b. **Seed the editor from the REST working copy ONLY when the live Yjs doc is empty,
   and ONLY after the WS sync event.** (`Editor.tsx` listens to `sync`, the typed
   event y-websocket emits right after the untyped `synced`, with the same state.)
   On a warm reload the WS server restores the prosemirror fragment — Yjs is the source
   of truth and the Collaboration plugin already shows the content. The seed runs inside `onSynced` (Editor.tsx) so the authoritative
   server state has loaded before we test emptiness; seeding earlier (e.g. from
   `initialize()` before WS sync) would mint fresh structs that then collide with the
   server's on sync — the same divergence as rule 0. `setContent` over a non-empty doc
   becomes delete-all + insert-new on the fragment (via ySyncPlugin), creating a competing
   parallel state the 2s resync fights — reverting the user's content (the reload
   "heartbeat", reproducible via Ctrl+S then reload). Guard with `!editor.isEmpty` /
   `emptyShared`; only seed when the server genuinely has nothing.

4. **`saveTimer` must be nulled when the debounce timer fires** (inside the
   `setTimeout` callback). The missed-timer recovery in `performSave`'s `finally` checks
   `!this.saveTimer`; a stale (fired-but-not-nulled) ref makes it skip rescheduling and
   silently drops edits typed during an in-flight save.

5. **Empty-doc guard:** autosave never persists a 0-block document (it would wipe the
   working copy). Only explicit `forceSave`/`publish` may write empty.

6. **Run-once content load:** `Editor.tsx` guards the `onSynced` content-load with
   `hasInitializedRef` (reset only on `postId` change). The provider's `sync` event
   re-fires on every reconnect; without the guard, reconnects re-run `setContent` and
   clobber in-progress typing. The persistence manager has its own `hasInitialized`.

7. **Editor plugins with `appendTransaction` (or `filterTransaction`) MUST ignore
   collaboration-sync transactions.** `components/editor/extensions/BlockIdExtension.ts`
   assigns `data-block-id`s; it ran on *every* `docChanged`, including the transactions
   `ySyncPlugin` dispatches for **remote** Yjs updates, and minted a fresh
   `crypto.randomUUID()` each time. That made a sync→appendTransaction→sync feedback loop
   (random ids never converge) — a primary driver of the "heartbeat" content/image
   erasure, distinct from rule 0. Guard with TipTap's `isChangeOrigin(tr)` (from
   `@tiptap/extension-collaboration`): `if (transactions.some(tr => isChangeOrigin(tr)))
   return null`. Only the client that originates a node assigns its id (top-level nodes
   and list items, #238); remote ids arrive
   as synced attributes and `pmToBlockDoc` backfills any missing at save time. Any future
   doc-mutating plugin must do the same. (BlockIdExtension also regenerates **duplicate**
   ids — splitting a block copies attrs incl. the id onto the new node; the `blocks` map
   is keyed by id, so duplicates silently collapse blocks on save. Keep both checks.)

8. **`yjs` must be the exact same version in `web/` and `websocket/`** (currently pinned
   `13.6.31`, no `^`), and y-websocket/y-protocols kept in lockstep. The two packages
   have separate lockfiles, so loose ranges drift apart silently; mixed yjs versions
   between peers can mis-integrate complex struct operations (Yjs requires all peers on
   one version). Related but distinct: the **server-side dual ESM/CJS instance** hazard —
   see `websocket/CLAUDE.md`, it's the top gotcha there.

9. **Restoring a version (#136) goes through the editor, never around it.**
   `BlockPersistenceManager.restoreVersion(doc)` (only after `hasInitialized`, i.e.
   after WS sync) applies the doc with `setEditorBlockDoc`, which the ySyncPlugin
   mirrors to peers, then `forceSave`s through the normal PUT. Overwriting
   `posts.block_doc` behind the live Yjs doc would be reverted by the next autosave
   of any open editor. It adopts the version's dropped-block record only after the
   editor accepted the doc. Returns `{ saved: false }` when a save was in flight (the
   follow-up save persists it).

## State machine flags (BlockPersistenceManager)

`isInitializing` (load latch, cleared 500ms after init in `finally`) · `isSaving`
(non-re-entrancy latch) · `suspended` (set on 401; cleared by `setAuthToken`→`resume`) ·
`hasInitialized` (run-once load) · `hasUnsavedChanges` · `editChangeSeq` (monotonic;
performSave snapshots it before the API call — if it advanced by the time the save
resolves, edits arrived mid-flight so DON'T clear `hasUnsavedChanges`) · `saveTimer`.

## blockBridge notes

- Every block node type needs the **`data-block-id`** attr (added globally by
  `BlockIdExtension` to paragraph/heading/blockquote/codeBlock/horizontalRule/image/
  bullet_list/ordered_list/listItem). Custom/theme nodes must declare it too or
  `schema.nodeFromJSON` throws "Unsupported attribute".
- `pmToBlockDoc` regenerates duplicate/invalid block ids.
- **Known limitation:** a `code_block` with empty code can't be shown in the editor
  (ProseMirror disallows empty text nodes). It is dropped like any other unbuildable
  block (see below), not thrown for the whole doc. Pinned by a test.
- **`schema.nodeFromJSON` does NOT validate content expressions** — it will happily
  build a schema-invalid node. Tests prove validity with `node.check()`.
- **Dropped blocks are hidden, never deleted (#213).** `blockDocToPMWithReport` builds
  and `check()`s **each top-level block, and each list child, on its own**. One that
  fails to build (e.g. an empty `code_block`, whose empty text node nodeFromJSON
  rejects) or to check is left out and reported as a `DroppedBlock` (its id, its parent
  list or null, and the sibling it followed). It never throws for the whole doc: if
  `setEditorBlockDoc` fails, `initialize()` has still seeded the maps, the editor is
  empty, and the next autosave would overwrite the entire working copy. The doc-level
  `block+` rule is not checked (an empty block doc stays an empty PM doc).
  `BlockPersistenceManager` records the drops on **every** load and conflict reload,
  warm or cold (a block dropped when Yjs was first seeded is still missing from the
  editor). It reports them once per load through `onSaveError`, and `performSave`
  merges them back into **every PUT** via `restoreDroppedBlocks`, at their original
  position or at the end if their anchor was deleted. Only the PUT payload carries
  them; the Yjs maps keep mirroring the editor. The maps are seeded from
  `pmToBlockDoc(<the repaired PM doc>)`, not the raw REST doc, so maps and editor agree
  from the start. The read-only view only logs drops.
- **List children:** the schema requires `listItem+`. A `paragraph` child is wrapped in
  a `listItem` (keeping its text and id); any other non-`listItem` child is dropped as
  above. A list left with no items (children empty, absent, all dangling, or all
  dropped) gets **one synthesized empty `listItem`**, keeping the list's block id and
  position. The synthesized item's id is **deterministic (`synthesizedItemId`:
  `<listId>-list-item`, always ≥ 10 chars)**, not random: the same block doc must give
  the same item id on every load, and in both the maps (seeded from `pmToBlockDoc` of
  the repaired doc) and the editor. Conversely, `pmToBlockDoc` **skips** a
  childless list node (only reachable from an already-invalid PM doc), so a childless
  list block is never persisted.
- **List item ids (#238):** `BlockIdExtension` stamps every `listItem` whose parent is
  a `bulletList`/`orderedList` (any depth), not just top-level nodes, regenerating
  missing/invalid/duplicate ids deduped across the whole doc. Before this, items made
  in the editor (Enter-split, paste, toggling a list) had no id or a copied duplicate,
  so `pmToBlockDoc` minted them a new id on **every** save and `setBlockDocV1` deleted +
  re-inserted them and rewrote the list's `children` each time (rule 2). Pinned by
  `components/editor/extensions/BlockIdExtension.test.ts` (headless `Editor`). Note for
  such tests: StarterKit's TrailingNode appends its own transaction (no sync meta) when
  the doc ends in a list, which re-runs `appendTransaction` without the rule-7 guard.
- **Paste (#128):** `components/editor/extensions/PasteSanitizer.ts` runs pasted HTML
  through DOMPurify (`transformPastedHTML`, local pastes only; no appendTransaction, so
  rule 7 doesn't apply) and the schema's parse rules turn the rest into nodes. It
  strips every `data-block-id` (also inside ProseMirror's `data-pm-slice` context), so
  pasted nodes always get fresh ids from BlockIdExtension and a copied id can never
  re-key the original block. Pasted images are dropped by design (insert via the media
  library). Pinned by `PasteSanitizer.test.ts` (fixtures, schema check, bridge
  round-trip) and `PasteSanitizer.collab.test.ts` (two peers converge, no loop).
- **Cycles:** `listItemsToPM` tracks the lists being converted. A list that (directly
  or through another list) contains itself throws at the child that closes the cycle,
  so that child is dropped and reported like any other bad child. Nothing recurses
  unboundedly, and `restoreDroppedBlocks` keeps the stored structure on save.
- Heading levels are **1–6** (`HeadingBlock.level`, `zHeading`, the bridge, and the
  editor schema all allow the full range — keep them in sync). `validateBlockDoc` has no
  production caller yet; the collab server's store will call it (#206 P2, #214). A
  **known** block type must match its own Zod schema (a malformed heading is no longer
  accepted as a "custom" block); only unknown types use the custom catch-all. Both
  validators return the **input object**, never Zod's parse output, which strips keys the
  schemas don't list (e.g. list `children`).
- **y-tiptap deletes what a client's schema can't build.** In `createNodeFromYElement`, a
  failing `schema.node()` (e.g. a theme node type the editor didn't register) is caught,
  and the element is **deleted from the shared Y doc**, for every peer and the next save.
  The editor waits for the theme (#198), but a failed theme load still mounts it, and so
  does a post with blocks from a theme that is no longer active. Pinned by the hazard test
  in `fragmentBridge.editor.test.ts`. Any guard (don't bind, or bind read-only, when the doc
  holds unknown node types) must keep that test meaningful.

## Canonical store & the WS layer

- **Postgres `posts.block_doc` is canonical** (via the REST autosave
  `PUT /api/v1/posts/:id/blocks`). The WS server's LevelDB is only a *safety net* for
  in-flight Yjs state. See `websocket/CLAUDE.md`.
- **Diagnostic finding (convergence harness, `reconnect.test.ts`):** at the pure-CRDT
  sync level, content is NEVER lost — not on disconnect, server restart, cleared
  snapshot, or repeated resyncs. **Caveat learned the hard way:** these tests run in ONE
  module system, so they can never reproduce the production dual-instance hazard
  (ESM tests + CJS server builds). A green harness rules out CRDT logic, NOT the
  server's runtime environment.
- **Debugging a "server reasserts stale state every 2s" symptom:** that cadence is
  `resyncInterval: 2000`; a server doc that stops integrating a client's updates
  ("wedged" — typically right after a structural edit like an Enter-split or
  paragraph→heading) re-erases the client on every resync. First check the websocket
  container logs **from the very top** for "Yjs was already imported" and for swallowed
  stack traces from y-websocket's messageListener (it `console.error`s and drops failed
  integrations, leaving a permanent causal gap).

## How to test headlessly

- Bridge: build a schema with `getSchema([StarterKit, TextAlign, ImageWithMediaId,
  BlockIdExtension, …])` (see `blockBridge.test.ts`).
- Managers: real `new Y.Doc()`; `vi.mock("../api/blockAPI")` for the API client;
  `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(ms)` to drive the 1.5s debounce.
- Reconnect/convergence: `reconnect.test.ts` models two `Y.Doc`s + a relay + server
  restart. Encode any newly-found reconnect bug as a red test here.

## Open follow-ups (don't "fix" silently — they're intentional/known)

- **409 conflict discards local unsaved edits** (server-wins). `resolveConflict`
  reconciles to the server copy and clears `hasUnsavedChanges`, so the retry no-ops.
  A real client-wins/merge (or at least a user warning) is wanted. Pinned by a test.
- `setBlockDocV1` still does full delete+insert on the **order array** when it differs
  (fine — small, infrequent) and still rewrites *changed* blocks (expected).
- Strategic refactor on the table: replace the bespoke y-websocket demo-server stack
  with **Hocuspocus** (server-side load/store of `block_doc`, client becomes a dumb
  editor) — tracked as a GitHub issue in the MVP milestone.
</content>
