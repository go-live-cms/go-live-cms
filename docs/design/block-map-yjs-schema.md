# Block-map Yjs schema: design and recommendation (#315)

Status: **decision proposed**, 2026-11. No code ships with this document.

Feeds: #328 (per-block "Last edited by"), #192 (block comments), #352 (block library,
nested blocks). Background: #122, #206 (Hocuspocus), #286.

## Summary

**Recommendation: adopt partially.** Keep the `"default"` XmlFragment as the only source
of truth for content and block order. Do **not** move blocks into per-block `Y.Map`s and
do **not** write a custom TipTap binding. Adopt the useful half of the idea instead:

1. **The block id is the anchor.** Everything that is "about a block" (attribution,
   comments, later locks or permissions) is keyed by the block's `data-block-id`, which
   has been stable since #238 (list items), #128/#264 (paste strips copied ids) and the
   server's `stampFragmentBlockIds`. The rules that keep an id stable are written down
   below and become a contract.
2. **Per-block side data lives in Postgres, next to `block_doc`, not in new Yjs root
   maps.** The collab server is the only writer of block attribution (#328), in the same
   transaction as the `block_doc` write. Comments (#192) are ordinary API resources with
   their own tables and authorization, and the collab server only relays a "comments
   changed" nudge to open editors.
3. **A server-side block change tracker.** The collab server learns which blocks each
   connection changed from the Yjs transactions it applies (Hocuspocus applies a
   client's update with that client's `Connection` as the transaction origin). #328
   needs it for attribution, #352 needs the same thing to enforce admin-only blocks, and
   it allows an incremental `fragmentToBlockDoc` later if large docs need it.

The full block-map would make the editor binding ours to maintain, in the subsystem
with the worst incident history. In exchange it gives a move operation that survives
concurrent edits and a closer match to Block Spec. Neither feature waiting on #315
needs either of those.

## Today

```
TipTap 3.4.2 + y-tiptap 3.0.0 (ySyncPlugin)
        │  binds the whole PM doc to one Y.XmlFragment
        ▼
Y.Doc "post-<id>"
  ├─ "default"  Y.XmlFragment   content + order (one Y.XmlElement per PM node)
  └─ "meta"     Y.Map           server-owned: epoch, dropped (plus the client's restore record)
        │
        ▼ collab server (the only writer of block_doc)
  load:  block_doc → seedFragment → "default"          (load.ts, only when no usable state)
  store: stampFragmentBlockIds → fragmentToBlockDoc     (store.ts, debounced 2s / max 10s)
         → validateBlockDoc → PUT /internal/posts/:id/collab {state, epoch, block_doc?, last_editor_id?}
        │
        ▼
posts.block_doc (Block Spec v1/v2)   post_ydoc_state (state, epoch, block_revision, last_editor_id)
```

Things in place that any design must keep:

- Rule 0: nothing on the device. Rule 8/13: one pinned `yjs` (13.6.31), one instance.
- Rule 9: restore goes through the editor (`restoreVersionLive` → `setEditorBlockDoc`).
- Rule 10: never bind a doc the editor's schema can't build (y-tiptap deletes what it
  can't build).
- Rule 11/12: only the server seeds; the revision and epoch guards.
- `block_doc` is derived on every store, and a store whose `block_doc` is unchanged
  writes state only, with no revision bump (#307).
- `post_ydoc_state.last_editor_id` already records who triggered the last store. It is
  one id per store, not per block.

## What the block-map would look like

The schema #122 had in mind, close to Block Spec:

```
Y.Doc
  ├─ "blocks_order"  Y.Array<BlockID>                 top-level order
  ├─ "blocks"        Y.Map<BlockID, Y.Map>            one map per block:
  │                    type, version     (scalars)
  │                    attrs             Y.Map  (scalars, last writer wins)
  │                    content           Y.XmlFragment (the block's inline / child PM content)
  │                    children          Y.Array<BlockID> (lists, later containers)
  └─ "meta"          Y.Map
```

Text must still be a Yjs XML or text type inside each block, or two people typing in one
paragraph overwrite each other. So each block keeps a small ProseMirror subtree, and the
per-block PM ⇄ Block Spec conversion stays. The block-map removes the top-level step of
the derive, not the conversion.

(The pre-#206 client kept a `blocks` map and a `blocks_order` array as a mirror of the
fragment. That mirror was the "incremental Block Spec mirror" whose reconciliation with
the fragment caused a class of the 2026-06 bugs. It was removed in P5, and `load.ts`
still empties it in old docs. The block-map discussed here would be the source of truth,
not a mirror. The root names would have to differ from the legacy ones, which old stored
docs may still contain.)

## Binding options

### Option A: block-map as source of truth, custom binding

y-tiptap's `ySyncPlugin` binds **one** PM doc to **one** `Y.XmlFragment`. Remote changes
re-render the PM doc from the fragment, and local transactions run `updateYFragment`,
which diffs the PM doc against the fragment. Nothing in it understands an order array
plus a map of blocks, so Option A means writing our own sync plugin:

- PM → Yjs: work out from each transaction which top-level nodes were inserted,
  deleted, moved, split, merged or edited, keyed by block id. Then apply them as
  `blocks_order` / `children` operations, map entries, and per-block `updateYFragment`
  calls on each block's `content`. Split (Enter mid-paragraph) and join (Backspace at
  the start) touch two blocks and the order in one transaction.
- Yjs → PM: rebuild only the affected top-level nodes from the changed maps. Dedupe
  `blocks_order` on read: Yjs has no move operation, so two users moving the same block
  each delete and re-insert its id, and the id ends up in the array twice. Tolerate an
  id in the order with no map entry (a concurrent delete and move), and repair both in
  the server's store.
- Positions: carets and selections (`CollaborationCaret`), the Yjs undo manager, and
  the drag handle (`@tiptap/extension-drag-handle` peer-depends on `@tiptap/y-tiptap` and
  `@tiptap/extension-collaboration`) all go through y-tiptap's binding state
  (`ySyncPluginKey`) and its relative position helpers, which walk a single fragment.
  Each needs a replacement that maps a PM position to (block id, relative position in
  that block's content) and back.
- Rule 10 has to be rebuilt: today's gate runs `findUnbuildableTypes` on the fragment
  before binding. y-tiptap's delete-what-can't-be-built behaviour would live in our own
  code instead, which is better, but it has to be written.

What it buys:

- **A move that keeps concurrent edits.** Today a drag-handle move is a PM delete plus
  insert. y-tiptap writes that as a deleted `Y.XmlElement` and a new one, so another
  user's typing in that block during the move lands in the deleted element and is lost.
  With the block-map a move only touches `blocks_order`. This is the one real CRDT
  improvement. It needs a move and an edit of the same block within the same sync round
  trip, which is rare in practice.
- A store that is mostly a projection (the doc already has Block Spec's shape).
- Natural places for per-block metadata. As shown below, that metadata is better kept
  out of the Yjs doc anyway.

What it does not buy:

- **Partial reads or writes.** Hocuspocus loads, syncs and stores the whole doc
  (`Y.encodeStateAsUpdate`). The binding still renders the whole PM doc. Only
  subdocuments would make loading partial, and they are a separate, larger change. A
  cheaper store is possible today too (see "Block change tracker").
- **Fewer unconvertible blocks.** A malformed node is malformed in a block's `content`
  just as in the fragment. The per-node fallback in `fragmentToBlockDoc` already confines
  the damage to one block.

Size: a new binding (sync, carets, undo, positions), on the order of y-prosemirror's
sync code; rewrites of `fragmentBridge.ts` (seed, store, stamping), `schemaGuard.ts`,
`load.ts`/`store.ts`, the relay testkit's assumptions and about 24 files that reference
the fragment; a migration of every stored doc (below); and every collab test re-proved.
That is several weeks of work in the subsystem that caused the 2026-06 data-loss saga.
It also takes on a long-lived cost: every TipTap or y-tiptap upgrade (`web/CLAUDE.md`,
"Upgrading TipTap") would have to be checked against our own binding rather than
upstream's.

### Option B: keep the fragment, add Yjs side maps keyed by block id

The fragment and `ySyncPlugin` stay as they are. New root maps sit next to them, e.g.
`Y.Map("block_meta")` for attribution and `Y.Map("comments")` for threads, keyed by
`data-block-id`. TipTap needs no change: the editor reads `ydoc.getMap(...)` like
`liveRestore.ts` reads `meta`. This is cheap, and existing docs need no migration (a
root map that doesn't exist yet is just empty).

Its problems are trust and lifetime, not binding:

- **Any writable connection can write any root type.** Hocuspocus has no per-type write
  permission. A collaborator could rewrite another user's comment or set "Last edited by"
  to anyone. #352 runs into the same fact for admin-only blocks.
- **Read-only connections can't write at all.** Hocuspocus drops every update from a
  read-only connection before applying it (`MessageReceiver`, `connection.readOnly`). A
  contributor viewing someone else's post, a demoted or `unverified` connection, and the
  static view of rule 10 could not comment. Letting read-only connections write only the
  comments map would mean decoding and filtering each update on the server.
- **A reseed loses them.** When `block_doc` was written around the collab server (a
  restored backup, a manual fix), the API withholds the stale state and the server seeds
  a new doc from `block_doc` (rule 12). Anything kept only in Yjs is gone. Any data we
  must not lose would need a second copy in Postgres anyway.
- **Pruning fights restore.** Entries for deleted blocks have to be removed sometime, or
  the doc grows forever. But restoring a version (#136) brings old block ids back, and an
  entry pruned in between is lost. Postgres rows can be kept (comments) or rebuilt
  (attribution) without that conflict.
- **State size.** Everything in the doc, including the history of every comment, goes to
  every client on every open and into every store.

### Option C (recommended): keep the fragment, anchor by block id, side data in Postgres

Same binding as today, and the same anchor as Option B, but the data lives in tables the
API owns:

- **Attribution (#328):** written by the collab server in the store transaction, only
  when that store writes `block_doc`.
- **Comments (#192):** written through REST by whoever may read the post, with per-comment
  authorization in the API. The collab server broadcasts a stateless "comments changed"
  message so open editors refetch.

The Yjs schema doesn't change: no migration, no change to the seed path, no binding work.
The block id contract plus the change tracker are what A and C share, so if Option A is
ever needed, this work carries over to it.

## Comparison

| | A: block-map + custom binding | B: fragment + Yjs side maps | C: fragment + Postgres side data |
|---|---|---|---|
| Binding work | New sync, caret, undo and position code | None | None |
| `post_ydoc_state` migration | Every doc converted, new epoch | None (additive) | None |
| Seed path (`load.ts`) | Rewritten | Unchanged | Unchanged |
| Concurrent move + edit | Edit kept | Edit lost (as today) | Edit lost (as today) |
| Side data writable by | Any writable client | Any writable client | Server (attribution), API with auth (comments) |
| Read-only users can comment | No | No | Yes |
| Survives reseed | No (unless copied to DB) | No | Yes |
| Restore (#136) | Through the new binding | Pruning vs restore conflict | Orphan, then reattach |
| Risk | High (rule 9/10 paths, data loss history) | Low | Low |
| Size | Weeks | Days | Days per feature |

## Migration of `post_ydoc_state` and the seed path

**Option C and B:** nothing to migrate. `post_ydoc_state` keeps its rows. `load.ts` keeps
seeding `"default"` from `block_doc`. New tables come with ordinary migrations
(`db/migration/0000NN_*`), and the backup restore test (`scripts/backup/test-restore.sh`)
covers them like any table.

**Option A, for the record:** Yjs structs can't be converted in place. The new layout
needs new structs, so every post is effectively reseeded:

1. The collab server and the editor need a **schema version** in the protocol, not just
   the epoch. An old editor bundle in an open tab that connects without an epoch would
   bind to a `"default"` fragment the new server no longer reads. It would show an empty
   post, and its typing would be silently ignored. The server has to refuse a client whose
   schema version differs, and the client has to reload.
2. On load, a stored doc in the old layout is converted by the server from **the Yjs
   state, not from `block_doc`**: a post whose last store was `kept-invalid` has edits
   that `block_doc` doesn't. Convert with `fragmentToBlockDoc` (with `meta.dropped` and
   the previous doc), seed the new layout from the result under a new epoch, and carry
   `meta.dropped` over. If the conversion fails, refuse the load (as today's load errors
   do) rather than seeding from an older `block_doc`.
3. Every open tab is refused with `stale-epoch` once and remounts. Caret positions, undo
   history and anything else tied to old structs are dropped. The rollout is one
   coordinated deploy of the editor, collab and API images (already required, see "Mixed
   deploys" in `web/gl-admin/lib/collaboration/CLAUDE.md`), with no way back short of the
   reverse conversion.
4. `seedFragment` becomes a seed of the order array and maps. That part is simple,
   because Block Spec already has that shape.

## Interaction with revisions/restore, paste and id stamping

### Block identity contract

Everything keyed by block id depends on when an id survives. As built today:

| Edit | Block id | Why |
|---|---|---|
| Typing, formatting, attribute changes | Kept | Same node |
| Turn into (heading ⇄ paragraph, etc.) | Kept | `data-block-id` is a global attribute, carried over (Block Spec README) |
| Drag-handle move | Kept | PM moves the node with its attrs; the old copy is deleted in the same transaction, so BlockIdExtension sees no duplicate |
| Split (Enter) | First half keeps it, second half gets a new one | BlockIdExtension regenerates the later duplicate in doc order |
| Join (Backspace at start) | The block that absorbs the other keeps its id; the absorbed id is gone | Node removed |
| Copy and paste, cut and paste | New id | `PasteSanitizer` strips `data-block-id` (#128/#264), also in `data-pm-slice` |
| Wrap a paragraph into a list | The list and its item get new ids; the paragraph is no longer a block | Only top-level nodes and list items are blocks (#238) |
| Restore a version | The version's ids come back | `setEditorBlockDoc` builds nodes with the version's ids, and y-tiptap's diff keeps unchanged nodes |
| Duplicate post / from template | All new ids | #354, #322 |
| Server store | Only missing, short or duplicate ids are replaced | `stampFragmentBlockIds`, same rules as the editor |

Consequences for side data:

- **Keep stripping ids on paste.** If pasted nodes kept ids, a copy pasted *above* its
  original would keep the id, the original would be the later duplicate and get a new id,
  and the original's comments would move to the copy. Cut and paste losing the id is the
  price, and it is acceptable (see orphans in #192 below).
- Rule 7 still applies to any plugin added for these features: no `appendTransaction`
  that reacts to sync transactions.
- **Nested blocks (#352):** containers (columns, group, cover, media & text, details) stay
  ordinary PM nodes in the fragment. Their inner blocks need ids by the same rules. The
  "is this node a block" test, written twice today (`BlockIdExtension` and
  `stampFragmentBlockIds`: parent is the doc, or a list for `listItem`), should become one
  shared, schema-driven predicate (for example a NodeSpec flag on container types), so
  the stamping, the bridge and the change tracker below agree. #352 owns the details.
- Don't use the Yjs `clientID` for attribution (#328's note says updates carry one).
  It's per `Y.Doc`, not per user, it's chosen by the client, and a client can send
  someone else's structs. The authenticated connection that sent the update is what to
  trust.

### Revisions and restore (#136, #355, #358)

- Restore stays rule 9: `restoreVersionLive` → `setEditorBlockDoc`. Under Option C
  nothing about it changes. The restorer's transactions change the blocks whose content
  differs from the version, the server attributes exactly those to the restorer (#328),
  and comments on blocks the version lacks become orphaned and reattach if a later
  restore brings the block back (#192).
- Versions (`post_versions`) stay pure Block Spec. **Neither attribution nor comments go
  into `block_doc` or a version.** The public site reads `block_doc` through `/public`,
  where user ids don't belong. #355's diff compares block attrs, so extra attrs would
  show up as changes. And an attribute that changed without a content change would bump
  the revision, which #328 rules out.
- The revision and epoch guards don't change. A reseed only replaces the Yjs doc, so
  Postgres side data survives it.

### Paste sanitizing (#128)

Works at the ProseMirror level (`transformPastedHTML`) before anything reaches Yjs, so it
is the same under every option. Its id stripping is part of the identity contract above.

## Block change tracker (shared by #328 and #352)

Hocuspocus 3.4.4 applies a client's update with that client's `Connection` as the Yjs
transaction origin (`MessageReceiver`: `readUpdate(decoder, document, connection)`; the
`onChange` hook gets `transactionOrigin: connection` and that connection's `context`).
It drops a read-only connection's update before applying it. The server's own writes
(seed, legacy cleanup, stamping) use the string origin `SERVER_ORIGIN`. So per
transaction the server knows which authenticated user changed what.

Sketch (in `web/collab-server/`, per loaded doc, next to the `Session`):

```ts
// Which block element each connection touched since the last successful store.
type Touch = { userId: string; at: number }
const touched = new Map<Y.XmlElement, Touch>()

fragment.observeDeep((events, tr) => {
  const userId = tr.origin?.context?.userId          // a Connection; SERVER_ORIGIN has none
  if (!userId) return
  for (const event of events) {
    // the nearest block ancestor of what changed (shared isBlock predicate),
    // plus blocks inserted directly under the fragment or a list
    for (const element of blocksOf(event)) touched.set(element, { userId, at: Date.now() })
  }
})
```

- Key by **element**, not id: a block created by a client may have no id until the
  store's `stampFragmentBlockIds` gives it one. Resolve element → id at store time,
  after stamping.
- New Y elements don't show up in `tr.changed`. They appear as `changes.added` on their
  parent's event, which is why the sketch looks at inserted children too. Pin both paths
  with tests on the relay testkit (`hocuspocusRelay.testkit.ts`).
- Clear the entries a store covered only once the PUT succeeds, as `storedSnapshot` is
  handled. A failed store keeps them for the retry.
- #352 can use the same per-connection view to refuse admin-only blocks from a non-admin
  connection. Refusing has to happen before or instead of applying an update, which this
  tracker doesn't do: that part is #352's design.
- Later, if large docs make the full `fragmentToBlockDoc` on every store too slow, the
  touched set is what an incremental derive would re-convert. Not needed now.

## #328: per-block "Last edited by"

**Where it lives:** a table owned by the API, written only by the collab store.

```sql
CREATE TABLE post_block_edits (
  post_id   bigint NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  block_id  text   NOT NULL,
  user_id   bigint NULL REFERENCES users (id) ON DELETE SET NULL,
  edited_at timestamptz NOT NULL,
  PRIMARY KEY (post_id, block_id)
);
```

**How the server attributes a store:**

1. `prepareStore` stamps ids and derives `block_doc` as today.
2. Only when the decision is `write` (the derived `block_doc` differs from `previous`),
   compute the **changed blocks**: ids whose block, compared with `canonicalJSON`, is new
   or differs from `previous.blocks[id]`. Leave out blocks that `restoreDroppedBlocks` or
   the unconvertible fallback copied from `previous` or `meta.dropped`: no client changed
   them.
3. Attribute each changed block to its tracker entry (user, time of the edit). If a
   changed block has no entry, fall back to `session.lastEditorId` (only when
   `clientEdited`), so a tracker gap never drops attribution.
4. Send them with the store: `PUT /internal/posts/:id/collab {…, block_doc, block_edits:
   [{block_id, user_id, edited_at}]}`. `StorePostCollabTx` upserts them and deletes the
   post's rows whose `block_id` isn't in the new `block_doc`, in the same transaction.
   The API refuses ids that aren't in that `block_doc` and stores unknown users as NULL,
   the way `last_editor_id` is stored.

Why this meets the acceptance criteria:

- **No extra `block_doc` writes, no revision churn:** attribution is only sent with a
  store that writes `block_doc` anyway, and it is never part of `block_doc`. A state-only
  store (unchanged, invalid, empty-skipped) carries none. A move, or typing a character
  and deleting it before the store, changes no block's JSON and attributes nothing.
- **Survives reloads, restarts and reseeds:** it's in Postgres, not in the Yjs doc or in
  memory. Edits not yet stored when the process dies are lost together with their
  attribution, which is consistent. SIGTERM stores every doc first.
- **Can't be forged by a client:** clients never write it.

**Reading it:** `GET /posts/:id/block-edits` → `{ "<block_id>": { user: {id, name,
avatar}, edited_at } }` for anyone who can read the post in the admin. The editor loads it
once and refetches (debounced) on the collab server's `stored` message with `block_doc:
"written"`, the same trigger #326 and #355 already use. No change to the collab protocol.
The block menu reads it by the block's `data-block-id`. A block with no row (never edited
since this shipped, or from a duplicate or template) shows no line. Avatars render through
`Avatar` / `safeAvatarSrc` as everywhere else.

Edge cases:

- Several people edit one block between two stores: the last transaction wins. That is
  what "last edited by" means, and the window is at most `maxDebounce` (10s).
- Restore: blocks whose content the version changed are attributed to the restorer.
- A list block's JSON includes its children's ids, so adding, removing or reordering
  items attributes the list as well as the item. That's fine and needs no special case.
- `post_ydoc_state.last_editor_id` stays as it is (one id per store, used for activity).

## #192: block comments

**Correcting the issue body:** it predates Hocuspocus. `BlockPersistenceManager.ts`,
`CollaborationProvider.ts` and the client autosave were deleted in P5 (#285). The editor
never saves content now (rules 9 and 11). The connection lives in
`HocuspocusCollaboration.ts`, and there is no `api/post_blocks.go` save path to extend.
The 2026 design comment on #192 proposed a `Y.Map("comments")` persisted from
`onStoreDocument`. This document recommends against that (Option B's problems:
read-only reviewers couldn't comment, any writer could edit anyone's comment, and a
reseed would lose them).

**Where threads live:** in Postgres, keyed by `(post_id, block_id)`.

```sql
CREATE TABLE post_comment_threads (
  id          bigserial PRIMARY KEY,
  post_id     bigint NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  block_id    text   NOT NULL,           -- the anchor; see the identity contract
  created_by  bigint NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz NULL,
  resolved_by bigint NULL REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX ON post_comment_threads (post_id, block_id);

CREATE TABLE post_comments (
  id         bigserial PRIMARY KEY,
  thread_id  bigint NOT NULL REFERENCES post_comment_threads (id) ON DELETE CASCADE,
  author_id  bigint NULL REFERENCES users (id) ON DELETE SET NULL,
  body       text NOT NULL,              -- plain text, length-capped, rendered as text
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at  timestamptz NULL,
  deleted_at timestamptz NULL
);
```

**How they persist and sync:**

- REST under `/posts/:id/comments` (list threads with their comments, start a thread on a
  block, reply, edit or delete one's own comment, resolve and unresolve). Authorization
  is the API's, per comment. Suggested defaults, to be settled on #192: anyone who can
  read the post's working copy in the admin may comment and resolve, only the author
  edits or deletes a comment, and admins may delete any. Writes add activity events
  ("commented on", #324), which the review flow (#323) can use.
- **Live updates:** after a write, the API calls a new collab internal route (same secret
  and listener as `POST /internal/documents/:doc/recheck`) that broadcasts a stateless
  `{"type":"comments"}` to the doc's connections, and open editors refetch. If the call
  fails, nothing breaks: editors also refetch on reconnect and when the tab is shown
  again (as `PostForm` does for review requests). An older tab is unaffected:
  `HocuspocusCollaboration.handleStateless` already ignores message types it doesn't know.
- Nothing goes into the Yjs doc, `block_doc` or versions.

**Why this survives what #192 asks for:**

- **Reordering:** a drag-handle move keeps the block id, so the thread stays anchored.
- **Restore:** threads aren't part of the content. A version that has the block keeps the
  thread on it. A version that doesn't have it orphans the thread. The thread reattaches
  if a later restore brings the block back, because nothing was deleted.
- **Reloads, restarts, reseeds:** Postgres.
- **Orphans** (the block was deleted, joined into another, cut and pasted, or wrapped into
  a list): computed by the client as threads whose `block_id` isn't in the editor's
  current doc. Shown in a separate "on deleted blocks" list, never dropped (the 2026
  comment on #192). A thread on a block hidden by `meta.dropped` (#213) is still in
  `block_doc`, so the list can say "on a hidden block" instead.
- **New blocks:** the editor offers "Comment" only on a block whose id is set. If the API
  checks the id against `block_doc`, the editor first waits for the block to be stored
  (`EditorRef.whenAcknowledged()`, then the next `stored`). Otherwise the API checks only
  the id's format and the orphan rule covers the rest. Pick one on #192.
- Duplicating a post or creating one from a template copies no threads (the ids are new).

**Later, text-range comments** (the History board's note that comments stay attached to
the text they're about): keep the block anchor as the fallback and add an optional range
stored with the thread as encoded Yjs relative positions in the block. Relative positions
only mean something within one epoch, so a reseed falls back to the block anchor. That's
a follow-up, not part of #192's acceptance.

## Costs and risks of the recommendation

- **Two places hold block-related data** (the fragment and the side tables) and are kept
  in step only by block ids. The identity contract is what keeps them consistent, so the
  tests that pin it (BlockIdExtension, stamping, paste) now protect comments and
  attribution too. Each feature's tests should include move, split, join, paste, restore
  and reseed.
- **The concurrent move-and-edit loss stays.** Reconsider Option A if it is ever seen in
  practice, or if #352's nested containers make y-tiptap's fragment diff too lossy (for
  example, moving a column with everything in it). The anchor contract, the tracker and
  the Postgres side data carry over to A unchanged.
- **The tracker is new code in the collab server,** close to the store pipeline.
  It only reads the doc and session state, writes nothing into the doc, and only affects
  what goes into the PUT, so the worst case for a bug in it is wrong attribution, not
  lost content.
- **Two new tables and a few routes** per feature, plus one internal broadcast route.
  About a few days of work for each of #328 and #192, apart from the UI.

## Decision

Adopt partially (Option C). Close #315 with this document. #328 and #192 build on the
block id anchor and the Postgres side data described above. #352 uses the shared block
predicate and the change tracker, and decides nesting within the fragment.
