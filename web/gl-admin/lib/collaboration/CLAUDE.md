# Collaboration / editor — agent context (READ BEFORE EDITING)

This is the **most sensitive subsystem in the codebase**. It has bitten us repeatedly
with data-loss and feedback-loop bugs. It now has real test coverage — keep it green
and add to it. Run `npm test` from `web/` after any change here.

## The big mental model: TWO separate Yjs structures

A post's `Y.Doc` (keyed `post-<id>`) holds **two independent shared types**:

1. **`prosemirror` XmlFragment** — the editor content. The TipTap **Collaboration**
   extension binds the editor to this. This is what the user sees/types.
2. **`blocks` + `blocks_order` Y.Maps** — the **Block Spec v1 mirror**, managed by
   `BlockDocManager`. This is a *derived* representation used for persistence + SSR.

These are NOT automatically linked. The editor renders from (1); persistence saves (2).
A change in (1) only reaches (2) when something **mirrors** it (`pmToBlockDoc` →
`setBlockDocV1`). Most bugs here come from confusing the two or from the mirror.

## Files

- `CollaborationProvider.ts` — per-post singleton: `Y.Doc` + `WebsocketProvider`
  (`ws://…:1234`, `resyncInterval: 2000`) + `IndexeddbPersistence` (`post-<id>`).
  Ref-counted; destroyed 750ms after last release. **`resyncInterval: 2000` = the "2s"
  cadence** you'll see in any heartbeat-style bug.
- `BlockDocManager.ts` — CRUD over the `blocks`/`blocks_order` maps. `setBlockDocV1` is
  **incremental** (diff/upsert) — see below.
- `BlockPersistenceManager.ts` — the autosave **state machine**. The brains; most
  invariants live here.
- `blockBridge.ts` — `pmToBlockDoc` / `blockDocToPM`. Pure conversion.
- `debug.ts` — gated logging. Enable in browser: `localStorage.setItem("GL_DEBUG_COLLAB","1")`.
  Server side: `COLLAB_DEBUG=1`. Both are timestamped (`t=…`) so client+server logs align.

## Hard rules (violating these reintroduces shipped bugs)

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

3b. **Seed the editor from the REST working copy ONLY when the live Yjs doc is empty.**
   On a warm reload, IndexedDB + the WS server restore the prosemirror fragment and the
   blocks maps — Yjs is the source of truth and the Collaboration plugin already shows
   the content. `initialize()` must NOT `setContent`/`setBlockDocV1` over a non-empty
   Yjs doc: `setContent` becomes delete-all + insert-new on the fragment (via ySyncPlugin),
   creating a competing parallel state the 2s resync then fights — reverting the user's
   content (the reload "heartbeat", reproducible via Ctrl+S then reload). Guard with
   `!editor.isEmpty` / a non-empty `getBlockDocV1()`; only seed the side(s) that are empty.

4. **`saveTimer` must be nulled when the debounce timer fires** (inside the
   `setTimeout` callback). The missed-timer recovery in `performSave`'s `finally` checks
   `!this.saveTimer`; a stale (fired-but-not-nulled) ref makes it skip rescheduling and
   silently drops edits typed during an in-flight save.

5. **Empty-doc guard:** autosave never persists a 0-block document (it would wipe the
   working copy). Only explicit `forceSave`/`publish` may write empty.

6. **Run-once content load:** `Editor.tsx` guards the `onSynced` content-load with
   `hasInitializedRef` (reset only on `postId` change). The provider's `synced` event
   re-fires on every reconnect; without the guard, reconnects re-run `setContent` and
   clobber in-progress typing. The persistence manager has its own `hasInitialized`.

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
- **Known limitation:** a `code_block` with empty code can't round-trip (ProseMirror
  disallows empty text nodes) — `blockDocToPM` throws. Pinned by a test.

## Canonical store & the WS layer

- **Postgres `posts.block_doc` is canonical** (via the REST autosave
  `PUT /api/v1/posts/:id/blocks`). The WS server's LevelDB is only a *safety net* for
  in-flight Yjs state. See `websocket/CLAUDE.md`.
- **Diagnostic finding (convergence harness, `reconnect.test.ts`):** at the pure-CRDT
  sync level, content is NEVER lost — not on disconnect, server restart, cleared
  snapshot, or repeated resyncs. So editor-level bugs here are at the **editor-binding /
  autosave layer**, not in Yjs sync. Start debugging there.

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
- StarterKit history vs collaboration history conflict (see `web/CLAUDE.md`).
</content>
