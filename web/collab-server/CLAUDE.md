# Collab server (Hocuspocus) — agent context

The Hocuspocus 3 collab server (#206; built in P2, #282). TypeScript,
ESM, **inside `web/`**: it shares web's lockfile, so `yjs`, TipTap and `@hocuspocus/*`
match the editor by construction, and it imports the editor's own schema and Block Spec
bridge (`gl-admin/lib/collaboration/{schema,fragmentBridge,blockBridge}.ts`,
`gl-admin/lib/blocks-spec`). Read `gl-admin/lib/collaboration/CLAUDE.md` too.

**Status:** the editor's only collab server: the `collab` service on **:1235** in
`compose.dev.yaml`, and in prod `compose.yaml` behind Caddy's `/collab` (image
`ghcr.io/go-live-cms/collab`, pushed by CD). The API reaches it at
`COLLAB_INTERNAL_URL=http://collab:1236` (client side:
`gl-admin/lib/collaboration/CLAUDE.md`). It replaced the y-websocket server
(`websocket/`, LevelDB) at the P4 cutover (#284); P5 (#285) deleted that, so there is no
rollback. Guards, reseeding and verification: `docs/operations/collab-cutover.md`.

| File | What |
|------|------|
| `access.ts` | `verifyTicket`, `TicketReplayGuard`, `ticketIdentity`, `fetchDocAccess`, `isCollabDocName`, plus `accessMode` (write / read / deny). |
| `auth.ts` | `onAuthenticate` (`createAuthenticate`, deps injected). |
| `recheck.ts` | `createAccessRecheck`: periodic access re-check of open connections (#313). |
| `api.ts` | Client for the API's internal listener (#280 contract). |
| `load.ts` | `onLoadDocument`: restore stored state, or seed from `block_doc`. |
| `store.ts` | `onStoreDocument` pipeline (`prepareStore`). |
| `blockEdits.ts` | The block change tracker (#328): who changed which block, sent with stores that write `block_doc`. |
| `server.ts` | `createCollabServer`: the hooks wired into a Hocuspocus `Server`, plus `flush`. |
| `internal.ts` | Internal HTTP listener: `/healthz`, flush, user re-check (#333). |
| `logsafe.ts` | `logEvent`, `requestIdFrom`, `docNameForLog`, `clientContextForLog`. |
| `env.ts` | `readEnv`, `readSecretEnv` (`<NAME>_FILE`, #158) for `main.ts`. |
| `probe.ts`, `build.mjs`, `singleYjsInstance.mjs`, `main.ts` | Single-instance probe, esbuild bundle and its yjs plugin, entry point. |
| `importMetaGlob.mjs` | esbuild plugin: Vite's eager `import.meta.glob` (the installed theme blocks, #376). |
| `bundleChecks.mjs` | What `build.mjs` refuses in the bundle (a theme's or plugin's `editor`/`render`, React). |

## Theme blocks (#376)

The server converts with `getInstalledCollabSchema()` (the default `schema` of
`createCollabServer`): the core schema plus every installed theme block's headless node,
from `themes/*/blocks/*/index.ts`. `build.mjs` resolves that glob with `importMetaGlob`
when the bundle is built, so **adding or changing a theme block means rebuilding this
image** (the Dockerfile copies `themes/`). The build **fails** if a theme's `editor.ts` or
`render.tsx`, or React, gets into the bundle: only headless definitions belong here. It
also fails on any module from **`web/src`** (#320): the image ships `collab-server/`,
`gl-admin/` and `themes/` only, so a schema extension importing `@/lib/...` built locally and
in vitest but broke the Docker build. Shared rules belong in `gl-admin/lib/blocks-spec`. The
store validates installed theme blocks against their spec (`themeBlockLookup(schema)`),
the same rules as the API, and `collab_listening` logs `theme_blocks` (checked by
`process.test.ts`, which also stores an alert through the real bundle). Blocks of a theme
that isn't in the bundle are dropped at seed and kept in `meta.dropped`, and so are a
plugin's (`plugin:<slug>/<block>`, #452; `pluginBlocks.test.ts`). The editor/render leak
check covers `plugins/` too (`bundleChecks.mjs`, tested by `bundleChecks.test.ts`). Details:
`gl-admin/lib/collaboration/CLAUDE.md`, "Theme blocks".

Tests: `npx vitest run --project collab-server` (from `web/`; plain Node env).
`testkit.ts` has signed tickets, `FakeCollabApi` (the #280 contract in memory, and over
HTTP for the process test; users can be demoted, deleted or given a `passwordChangedAt`),
`FakeClock` (drives the access re-check) and a `HocuspocusProvider` client helper.

## Auth (`auth.ts`)

Same order and rules the old y-websocket server had (history: #216, #223, #233, #135).
The ticket arrives in Hocuspocus's first **auth message**, not the URL, so no proxy log
ever sees it.

doc name (`isCollabDocName`) → ticket present → `verifyTicket` (sig, iss, aud
`golive.admin-ws`, `ws_ticket`, exp, `doc === documentName`) → **burn the jti**
(`TicketReplayGuard`, before the lookup) → `ticketIdentity` → **schema fingerprint** (#416)
→ `fetchDocAccess` (`GET /internal/users/:id/access`, 3s timeout, `X-Request-ID`) → mode →
epoch check.

- **Schema fingerprint (#416):** the auth message is JSON `{ticket, schema}`
  (`gl-admin/lib/collaboration/schemaFingerprint.ts`, `decodeCollabAuthToken`; a bare
  string is a pre-#416 client's ticket with no fingerprint). `schema` must equal
  `schemaFingerprint(schema)` of the schema this server converts with
  (`collab.schemaFingerprint`, logged in full as `schema_fingerprint` on
  `collab_listening`); anything else, or none, is refused with **`schema-mismatch`**
  before the access lookup and before the doc is loaded (the epoch check loads it, and a
  load may seed and store), so the refused editor costs no write. Open connections aren't
  re-checked: the fingerprint only changes with a new bundle, whose restart reconnects
  every client. The admin bundle and this one must come from the same commit
  (`process.test.ts` checks the bundle's fingerprint against the admin's schema's). See
  rule 10 in `gl-admin/lib/collaboration/CLAUDE.md`. A tab from before #416 doesn't know
  the reason and keeps retrying with backoff (≤30s), each refused (`ws_deny`,
  `client_schema: "missing"`) until it is reloaded or closed: noisy, never a write.

- **Mode** (`accessMode`): `can_edit: true` (admins, editors, a contributor on their own
  post, #135, or with an edit access grant on a published post, #321) → read-write. Any other content role (`admin`/`editor`/`contributor`,
  `READ_ROLES`) → **`connectionConfig.readOnly = true`**: a live read-only view;
  Hocuspocus drops that connection's updates. Anything else, a 403/404 from the API, or
  a bad ticket → denied.
- **Reasons sent to the client** (`DENY`): `permission-denied`, `access-unavailable` (the
  API couldn't answer: retry with a fresh ticket), `stale-epoch` (see below),
  `post-trashed` (#327), `schema-mismatch` (#416: reload, never retry). Each denial logs
  `ws_deny` with the request id, user id and client context, never the ticket; a schema
  mismatch adds `client_schema` / `server_schema` (`fingerprintForLog`: 12 characters,
  `missing` or `invalid`, never what the client sent otherwise).
- The replay guard is in memory: **one collab process** (Hocuspocus keeps live docs in
  memory anyway).
- The context carries the ticket's `issuedAt`: the access re-check sends it again.

## Access re-check (`recheck.ts`, #313)

Every open connection's access is looked up again (same `GET /internal/users/:id/access`)
on a timer per **(user, doc)**: `COLLAB_ACCESS_RECHECK_MS` (60s) ±20% jitter, so
connections that opened together (a restart) don't all hit the API at once. One lookup per
(user, doc) per round: connections whose tickets have different `iat`s are looked up
oldest first, and once one passes the newer ones need no lookup (only `issued_at`
differs, and the API compares it with the password change alone).
- **`issued_at` is the original ticket's.** A password change or reset after connect
  makes the API answer 403 for that session → closed.
- `can_edit` false but still a content role (demoted; a contributor's post was published,
  #135) → **`connection.readOnly = true`** (Hocuspocus drops its updates from then on) and
  `sendStateless` `{"type":"access","mode":"read","reason":"demoted"}`. Promoted again →
  read-write, `reason:"restored"`.
- 403/404 (user or post deleted, ticket predates the password change) or no content role
  → `connection.close` with reason **`access-revoked`** (`ACCESS_REVOKED`); the client
  shows "session ended, sign in again" and never reconnects.
- **Lookup failure** (API down, slow, 5xx): the connection **keeps its mode**, the failure
  is logged once per outage (`ws_access_check_failed`) and retried every 10s. This fails
  open for `COLLAB_ACCESS_GRACE_MS` (120s) **after the last confirmed lookup** (at connect,
  or the last successful re-check) only: an API blip must not disconnect or freeze every
  editor, but an outage can't extend a revoked session's write access indefinitely. Past
  that a writable connection becomes read-only (`reason:"unverified"`, never closed) and
  goes back to read-write on the next successful lookup.
- A promotion back to read-write is in place; the client reconnects if the server dropped
  anything it sent while read-only (see `gl-admin/lib/collaboration/CLAUDE.md`).
- The `connected` hook only tracks a connection its document still has (one closed before
  the hook ran would never fire `onClose`).
- **On demand (#333):** `POST /internal/users/:id/recheck` on the internal listener
  (`COLLAB_INTERNAL_SECRET`, like flush) runs `checkUser(id)`: every (user, doc) group of
  that user is looked up now (a lookup already in flight is followed by another, since it may
  have read the API before the change committed), then goes back on the interval. The API
  calls it after a role change or a removal, so a demotion is read-only at once, and after an
  edit access grant or revoke (#321: the member's view-only connection turns read-write,
  `restored`, or back, `demoted`; `accessGrant.hocuspocus.test.ts`). Answers
  `{docs: n}` once queued; 400 for anything but a positive integer id.
- **Trash (#327):** the API answers the access lookup with **410 `post_trashed`** for a post in
  the trash (`fetchDocAccess` → `{trashed: true}`). At connect that's `DENY.trashed`
  (`post-trashed`); on a re-check the connection closes with **`post-trashed`**
  (`POST_TRASHED`), not `access-revoked`, so the editor says "moved to the trash" instead of
  "sign in again". The API calls **`POST /internal/documents/:doc/recheck`** (`checkDoc`, same
  secret, `{docs: n}`) right after a trash. The store on the last disconnect still goes through.
- **Transfer (#353):** the API calls the same document re-check (`checkDoc`) after a post
  changes owner: the old owner (a contributor) drops to read-only (`demoted`), a contributor
  who received it gets write (`restored`). No server change was needed; `FakeCollabApi.transferPost`
  models it in the tests.
- Not re-checked on other events (e.g. a store); the interval bounds how long a change
  takes when the API's call doesn't arrive.
- Tests: `recheck.test.ts` (fake connections, `FakeClock`) and
  `server.recheck.test.ts` (real server and clients: demote → later edits dropped,
  delete / password change → closed, outage → nobody disconnected).

## Load (`load.ts`) and the epoch

`GET /internal/posts/:id/collab` → `{block_doc, block_revision, ydoc_state?, epoch?}`.
- Stored state at the post's current revision → `Y.applyUpdate` it. The API omits stale
  state; if it also sends `ydoc_block_revision`, the server checks the match itself.
- Otherwise **seed** (the only place anything seeds; the client never does):
  `seedFragment` (`blockDocToPMWithReport` + `prosemirrorToYXmlFragment` into
  `"default"`), the `DroppedBlocks` record into `meta.dropped`, a **new `meta.epoch`**,
  and the seed is PUT right away (state + epoch only) so the epoch is durable. A failed
  seed PUT is retried like a failed store (and blocks the unload), or the next load would
  reseed with yet another epoch.
- The pre-#206 client's `blocks` map / `blocks_order` array are emptied if a stored doc
  still has them (`meta.restore_id` is left alone).
- **`block_doc` may be `{}`** (posts that never had blocks: most seeded posts, posts
  created without a body). `normalizeBlockDoc` (`api.ts`, and again in `loadIntoDoc` for
  callers that bypass it) maps only `null`/`{}` to `null`, which seeds an empty fragment.
  **Any other malformed shape throws**: the load fails and the connection is refused,
  rather than showing an empty editor whose next store would overwrite unknown content.
  Before #304, `{}` threw in `onLoadDocument`, which the client reported as "access
  denied" (editor stuck on "Connecting...").
- **No write for a still-empty post:** if `block_doc` was empty and the derived doc has
  no content (nothing, or only empty paragraphs such as TipTap's TrailingNode adds on
  open), the store is `unchanged`: no `block_revision`/`changed_at` bump for a post
  nobody edited.
- The REST side matches: `GET /posts/:id/blocks` and `GET /posts/:id/versions/:no` return
  `{}` as a well-formed empty doc (`parseStoredBlockDoc` in `api/post_blocks_handlers.go`).
- A load error refuses the connection; it never seeds over state it couldn't read.
- **Epoch guard:** a client that already holds structs of this doc connects with
  `?epoch=<epoch>` on the WebSocket URL (Hocuspocus 3's provider has no per-doc params).
  `onAuthenticate` loads the doc (or joins the load) and rejects a mismatch with
  `stale-epoch`; the client must destroy its `Y.Doc` and reconnect without an epoch.
  Merging old structs into a reseeded doc would duplicate the content. A rejected check
  unloads the doc again if no one else is connected.

## Store (`store.ts`, `server.ts`)

Hocuspocus `debounce: 2000`, `maxDebounce: 10000` (env-tunable), and on the last
disconnect. `prepareStore`:
1. `repairColumnsFragment` (#426: a columns count Yjs merged past 2–4, or an empty column, put
   back in shape; a fifth column's blocks move to the fourth, nothing is lost),
   `repairEmptyContainers` (#427: a cover or media & text a merge left with no block gets an empty
   paragraph) and `stampFragmentBlockIds` in the live doc (origin `SERVER_ORIGIN`; not a client edit);
2. `fragmentToBlockDoc` with `meta.dropped` (→ `restoreDroppedBlocks`) and the previous
   doc for nodes that can't be converted (a container's children one at a time, #414),
   then `dedupeBlockRefs` (repeats within one list, as the API does);
3. **`validateBlockDoc`** (#214 part 2). Invalid → `collab_store_invalid`, the Yjs state
   is stored **without** `block_doc`, so `posts.block_doc` keeps its last valid version;
4. **empty guard:** an empty result is written only if a client edited the doc since it
   was loaded; never after a failed seed (`collab_store_empty_skipped`);
5. unchanged `block_doc` → state only (no revision churn).
Then `PUT /internal/posts/:id/collab {state, epoch, block_doc?, last_editor_id?, base_revision, block_edits?}`
(`base_revision` = the revision loaded or last stored, on **every** store, the seed's
too: the API answers 400 to a state-only store without it and 409 when it's behind), and
`broadcastStateless` `{"type":"stored","revision","block_doc"}` or `{"type":"store_failed"}`.

- The store never throws (Hocuspocus calls it from an un-awaited debounce). A failed
  store is retried with backoff (2s → 60s), and `beforeUnloadDocument` refuses to unload
  a doc whose last store failed: it holds the only copy of those edits.
- A store whose doc snapshot equals the last stored one is skipped (`Y.equalSnapshots`).

## Per-block "Last edited by" (#328, `blockEdits.ts`)

Design: `docs/design/block-map-yjs-schema.md` ("Block change tracker", "#328"). Each
`Session` has a `BlockChangeTracker` on the `"default"` fragment (made after the load,
destroyed on unload). Its `observeDeep` keys entries by **Y element** (a new block may
have no id until the store stamps one) and takes the user from **`tr.origin.context.userId`**:
Hocuspocus applies a client's update with its `Connection` as the origin (`readUpdate` /
`readSyncStep2`) and drops a read-only connection's update first; `SERVER_ORIGIN` (seed,
cleanup, stamping) has no context and is ignored. Never the Yjs `clientID`.
- **Both detection paths:** an existing type in `tr.changed` (the event's target → the
  nearest block at or above it, `isBlockNode`, any depth: a list item's paragraph → the
  item, a caption → the image, a details' summary → the details (#421), a child added to a group → the group), and a **new element
  in its parent's `changes.added`** (Yjs leaves types created in the transaction out of
  `tr.changed`), with every block inside it (a pasted group).
- **Store:** only when the decision is `write`, after `stampFragmentBlockIds`: `capture()`
  resolves element → id, and `blockEditsFor` attributes the blocks that came from the
  fragment (not ones `restoreDroppedBlocks` or the unconvertible fallback copied in) whose
  `canonicalJSON` is new or differs from `previous`, to their entry; a **new** block
  without one goes to `lastEditorId` when `clientEdited`, an existing one without one to
  nobody (its change was the server's: a bridge that normalizes differently after a deploy,
  a doc the API sanitized). Sent as `block_edits: [{block_id, user_id,
  edited_at}]` with the PUT; the API writes them in `StorePostCollabTx`. A move, or an edit
  undone before the store, attributes nothing. A tracker exception logs
  `collab_block_edits_failed` and the store goes on without attribution.
- **Clearing:** only after a successful PUT that wrote `block_doc`, and only the entries
  captured when the store was prepared (an entry replaced during the PUT stays). A failed
  store keeps them for the retry; a state-only store (`unchanged`, `kept-invalid`,
  `kept-empty`) sends and clears nothing, or an edit stored while the doc was invalid would
  later fall back to whoever edited last.
- **The API trusts them for #320:** a mention's email names, and a reminder belongs to, the
  user these edits give for its block (`api/mention_notifications.go`). That is why they come
  from the connection, never the doc: a client could put any user id in a node's attrs.
- After the PUT, `stored` (`block_doc: "written"`) carries `edits` (what was just written,
  when any) so open editors merge it (`gl-admin/lib/blockEditsStore.ts`).
- Tests: `blockEdits.test.ts` (plain Y.Doc), `gl-admin/lib/collaboration/blockEdits.hocuspocus.test.ts`
  (relay: two users, new / nested / moved / pasted blocks, a failed store's retry, a
  kept-invalid store, no churn, a restart). `FakeCollabApi.blockEdits` mirrors the API.

## Internal listener (`internal.ts`)

Own port (`INTERNAL_PORT`, default 1236), **never published**.
- `GET /healthz`: unauthenticated, for the healthcheck.
- `POST /internal/documents/:doc/flush` with `Authorization: Bearer
  ${COLLAB_INTERNAL_SECRET}` (constant-time): runs the store now under the doc's
  `saveMutex` and waits. 200 `{flushed}` (also when the doc isn't loaded: nothing
  unsaved), 400 bad name, 401, **503 if the store failed** (publish must not go ahead).
- `POST /internal/documents/:doc/comments` (same secret, #192): `notifyComments` broadcasts a
  stateless `{"type":"comments"}` to the loaded doc's connections (read-only ones too) so open
  editors refetch the post's comments from the API. It never loads a doc and never touches its
  content. 200 `{connections: n}` (0: not loaded), 400 bad name, 401. Logs
  `collab_comments_nudge` / `collab_comments_denied`.

## Logging

(#142, #155, #220, #254) One JSON object per line via
`logEvent`. Events: `ws_connect`, `ws_close`, `ws_deny`, `ws_access_changed`,
`ws_access_revoked`, `ws_access_check_failed` (user id, doc, old → new mode), `collab_load`,
`collab_load_failed`, `collab_store`,
`collab_store_invalid`, `collab_store_empty_skipped`, `collab_store_unconvertible`,
`collab_store_failed`, `collab_block_edits_failed`, `collab_flush`, `collab_flush_denied`, `collab_listening`,
`collab_startup_failed`, `collab_shutdown`. Users by id only.
- **Never log the ticket, a secret, a request, its headers or params, or a store body.**
  `log-guard.test.ts` scans every log call in this directory's non-test files and fails
  on those identifiers (and on aliasing `console`). Log client context only through
  `clientContextForLog`.

## Single yjs instance (THE hazard; rule 13 in `gl-admin/lib/collaboration/CLAUDE.md`)

Two yjs builds in one process (ESM `yjs.mjs` + CJS `yjs.cjs`) have separate class
registries; cross-instance `Y.applyUpdate` silently corrupted live docs in the 2026-06
saga, in the old y-websocket server (an ESM `import "yjs"` plus y-websocket's CJS
`require("yjs")`; `npm ls` still showed one deduped copy). Guards:
- **The image runs the esbuild bundle** (`build.mjs`, `platform=node`, `format=esm`) with
  **no node_modules**. Its `single-yjs-instance` plugin resolves every `require()` of
  `yjs`, `lib0/*` and `y-protocols/*` as an ESM import, and the build **fails** unless
  exactly one yjs file is in the bundle.
- **Startup probe** (`probe.ts`): `new Document("probe") instanceof Y.Doc` (Hocuspocus's
  `Document` extends `Y.Doc`), else `collab_startup_failed` and exit 1.
- **`process.test.ts`** builds the bundle, spawns it with `node` from a temp dir, runs the
  auth matrix and flush against it, and fails if the output contains **"Yjs was already
  imported"**. It also proves that check fires on a real double load. CI runs it on Node
  22 (`web-tests`) and Node 24 (`collab-server-node24`), and the `docker` job smoke-runs
  the image (probe, no warning, healthy).
- In-process vitest resolves one yjs for everything, so it **can't** catch this; that's
  what the process test is for. Treat the warning as a release blocker.
- Never add a dependency that bundles its own yjs or loads it through CJS `require`
  outside the bundle (y-websocket's `bin/utils` and `y-leveldb` did, before #285).

## Versions

`@hocuspocus/server` and `@hocuspocus/provider` are pinned **exact** (`3.4.4`) in
`web/package.json`; their peer ranges accept `yjs` `13.6.31`, which (like `y-protocols`)
is pinned exact in the same file (rule 8). `paseto` `3.1.4`.

## Environment (`main.ts`)

`PORT` (1235), `HOST`, `INTERNAL_PORT` (1236), `INTERNAL_API_URL` + `ROLE_LOOKUP_SECRET`
(required; the API's internal listener and its secret), `COLLAB_INTERNAL_SECRET`
(required; what the API sends to flush), `PASETO_V4_PUBLIC_KEY_HEX` or
`PASETO_V4_PUBLIC_PEM_FILE`, `PASETO_ISSUER` (`golive.auth`). `ROLE_LOOKUP_SECRET`,
`COLLAB_INTERNAL_SECRET` and `PASETO_V4_PUBLIC_KEY_HEX` may instead come from the file
`<NAME>_FILE` names (`env.ts`, #158; prod `compose.yaml` mounts the two secrets at
`/run/secrets`; both set is a startup error). `process.test.ts` starts the bundle that way.
`COLLAB_STORE_DEBOUNCE_MS` / `COLLAB_STORE_MAX_DEBOUNCE_MS`, `COLLAB_ACCESS_RECHECK_MS`
(60000; 0 turns the re-check off) / `COLLAB_ACCESS_GRACE_MS` (120000). In dev compose, the one-shot
`collab-key` service copies only the public key and issuer out of `app.env` (which also
holds the API's private keys) into a volume the `collab` command sources. It exits 1 on anything
missing. SIGTERM closes all connections (storing every doc) for up to 10s, then exits.

Dev: `docker compose -f compose.dev.yaml up -d --build collab` (the service runs the
bundle, so rebuild after changes); logs: `docker compose -f compose.dev.yaml logs -f collab`.
