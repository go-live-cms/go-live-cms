# Collab server (Hocuspocus) — agent context

The Hocuspocus 3 server that replaces `websocket/` (#206; this is P2, #282). TypeScript,
ESM, **inside `web/`**: it shares web's lockfile, so `yjs`, TipTap and `@hocuspocus/*`
match the editor by construction, and it imports the editor's own schema and Block Spec
bridge (`gl-admin/lib/collaboration/{schema,fragmentBridge,blockBridge}.ts`,
`gl-admin/lib/blocks-spec`). Read `gl-admin/lib/collaboration/CLAUDE.md` too.

**Status:** runs in dev **next to** the y-websocket `websocket` service, as the `collab`
compose service on **:1235**. The editor still uses `websocket` (:1234) until P3 (#283)
adds the client behind `PUBLIC_COLLAB_BACKEND`, and P4 cuts over. Not in prod
`compose.yaml` yet (P5).

| File | What |
|------|------|
| `access.ts` | Ported from `websocket/access.js`: `verifyTicket`, `TicketReplayGuard`, `ticketIdentity`, `fetchDocAccess`, `isCollabDocName`, plus `accessMode` (write / read / deny). |
| `auth.ts` | `onAuthenticate` (`createAuthenticate`, deps injected). |
| `api.ts` | Client for the API's internal listener (#280 contract). |
| `load.ts` | `onLoadDocument`: restore stored state, or seed from `block_doc`. |
| `store.ts` | `onStoreDocument` pipeline (`prepareStore`). |
| `server.ts` | `createCollabServer`: the hooks wired into a Hocuspocus `Server`, plus `flush`. |
| `internal.ts` | Internal HTTP listener: `/healthz`, flush. |
| `logsafe.ts` | Ported `logEvent`, `requestIdFrom`, `docNameForLog`, `clientContextForLog`. |
| `probe.ts`, `build.mjs`, `main.ts` | Single-instance probe, esbuild bundle, entry point. |

Tests: `npx vitest run --project collab-server` (from `web/`; plain Node env).
`testkit.ts` has signed tickets, `FakeCollabApi` (the #280 contract in memory, and over
HTTP for the process test) and a `HocuspocusProvider` client helper.

## Auth (`auth.ts`)

Same order and rules as `websocket/upgrade.js` (see `websocket/CLAUDE.md` → Auth for the
history: #216, #223, #233, #135). The ticket now arrives in Hocuspocus's first **auth
message**, not the URL, so no proxy log ever sees it.

doc name (`isCollabDocName`) → ticket present → `verifyTicket` (sig, iss, aud
`golive.admin-ws`, `ws_ticket`, exp, `doc === documentName`) → **burn the jti**
(`TicketReplayGuard`, before the lookup) → `ticketIdentity` → `fetchDocAccess`
(`GET /internal/users/:id/access`, 3s timeout, `X-Request-ID`) → mode → epoch check.

- **Mode** (`accessMode`): `can_edit: true` (admins, editors, a contributor on their own
  post, #135) → read-write. Any other content role (`admin`/`editor`/`contributor`,
  `READ_ROLES`) → **`connectionConfig.readOnly = true`**: a live read-only view;
  Hocuspocus drops that connection's updates. Anything else, a 403/404 from the API, or
  a bad ticket → denied.
- **Reasons sent to the client** (`DENY`): `permission-denied`, `access-unavailable` (the
  API couldn't answer: retry with a fresh ticket), `stale-epoch` (see below). Each
  denial logs `ws_deny` with the request id, user id and client context, never the ticket.
- The replay guard is in memory: **one collab process** (Hocuspocus keeps live docs in
  memory anyway).
- Access is checked only at connect (P6 follow-up: periodic re-check).

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
- The old client's `blocks` map / `blocks_order` array are emptied (`meta.restore_id`
  is left alone).
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
1. `stampFragmentBlockIds` in the live doc (origin `SERVER_ORIGIN`; not a client edit);
2. `fragmentToBlockDoc` with `meta.dropped` (→ `restoreDroppedBlocks`) and the previous
   doc for nodes that can't be converted;
3. **`validateBlockDoc`** (#214 part 2). Invalid → `collab_store_invalid`, the Yjs state
   is stored **without** `block_doc`, so `posts.block_doc` keeps its last valid version;
4. **empty guard:** an empty result is written only if a client edited the doc since it
   was loaded; never after a failed seed (`collab_store_empty_skipped`);
5. unchanged `block_doc` → state only (no revision churn).
Then `PUT /internal/posts/:id/collab {state, epoch, block_doc?, last_editor_id?}`, and
`broadcastStateless` `{"type":"stored","revision","block_doc"}` or `{"type":"store_failed"}`.

- The store never throws (Hocuspocus calls it from an un-awaited debounce). A failed
  store is retried with backoff (2s → 60s), and `beforeUnloadDocument` refuses to unload
  a doc whose last store failed: it holds the only copy of those edits.
- A store whose doc snapshot equals the last stored one is skipped (`Y.equalSnapshots`).

## Internal listener (`internal.ts`)

Own port (`INTERNAL_PORT`, default 1236), **never published**.
- `GET /healthz`: unauthenticated, for the healthcheck.
- `POST /internal/documents/:doc/flush` with `Authorization: Bearer
  ${COLLAB_INTERNAL_SECRET}` (constant-time): runs the store now under the doc's
  `saveMutex` and waits. 200 `{flushed}` (also when the doc isn't loaded: nothing
  unsaved), 400 bad name, 401, **503 if the store failed** (publish must not go ahead).

## Logging

Ported from `websocket/logsafe.js` (#142, #155, #220, #254): one JSON object per line via
`logEvent`. Events: `ws_connect`, `ws_close`, `ws_deny`, `collab_load`,
`collab_load_failed`, `collab_store`,
`collab_store_invalid`, `collab_store_empty_skipped`, `collab_store_unconvertible`,
`collab_store_failed`, `collab_flush`, `collab_flush_denied`, `collab_listening`,
`collab_startup_failed`, `collab_shutdown`. Users by id only.
- **Never log the ticket, a secret, a request, its headers or params, or a store body.**
  `log-guard.test.ts` scans every log call in this directory's non-test files and fails
  on those identifiers (and on aliasing `console`). Log client context only through
  `clientContextForLog`.

## Single yjs instance (THE hazard; see `websocket/CLAUDE.md`'s top gotcha)

Two yjs builds in one process (ESM `yjs.mjs` + CJS `yjs.cjs`) have separate class
registries; cross-instance `Y.applyUpdate` silently corrupted live docs in the 2026-06
saga. Guards:
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
- Never add a dependency that bundles its own yjs, or `y-websocket`'s `bin/utils` /
  `y-leveldb` (the old CJS sources).

## Versions

`@hocuspocus/server` and `@hocuspocus/provider` are pinned **exact** (`3.4.4`) in
`web/package.json`; their peer ranges accept `yjs` `13.6.31`. `yjs` stays in lockstep
with `websocket/` until that is deleted (P5). `paseto` `3.1.4` (same as `websocket/`).

## Environment (`main.ts`)

`PORT` (1235), `HOST`, `INTERNAL_PORT` (1236), `INTERNAL_API_URL` + `ROLE_LOOKUP_SECRET`
(required; the API's internal listener and its secret), `COLLAB_INTERNAL_SECRET`
(required; what the API sends to flush), `PASETO_V4_PUBLIC_KEY_HEX` or
`PASETO_V4_PUBLIC_PEM_FILE`, `PASETO_ISSUER` (`golive.auth`),
`COLLAB_STORE_DEBOUNCE_MS` / `COLLAB_STORE_MAX_DEBOUNCE_MS`. It exits 1 on anything
missing. SIGTERM closes all connections (storing every doc) for up to 10s, then exits.

Dev: `docker compose -f compose.dev.yaml up -d --build collab` (the service runs the
bundle, so rebuild after changes); logs: `docker compose -f compose.dev.yaml logs -f collab`.
