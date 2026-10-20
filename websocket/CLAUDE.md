# WebSocket collaboration server — agent context

Node, ESM (`"type": "module"`). A `y-websocket` server with **PASETO v4.public** auth
and **LevelDB** persistence. Port 1234. Entry: `server.js`. Dev: `npm run dev`
(nodemon). Tests: `npm test` (`node --test`).

## Auth

Clients connect with `ws://…:1234/post-<id>?ticket=<collab ticket>`. Outside dev, the
editor uses `${host}/collab/post-<id>` through a reverse proxy, and `stripCollabPrefix`
drops `/collab` whether or not the proxy did.

**Never the access token (#233).** Browsers can't set headers on a WebSocket handshake, so
the credential is in the URL, and every proxy or load balancer access log in front of :1234
records it. Before **every** connect and reconnect, the editor POSTs `{doc}` to
`/api/v1/collab/tickets` (`ticketSocket.ts`, via y-websocket's `WebSocketPolyfill` hook).
It gets back a v4.public ticket: audience `golive.admin-ws`, `token_type: ws_ticket`, a
`doc` claim, `user_id`, 30s TTL and a unique jti (`token/ws_ticket.go`). A ticket is not an
API bearer token (wrong audience and type), and the API never accepts one back.
`takeCredential` reads only `?ticket=`. There is no `?token=` / access-token fallback,
because the editor and this server ship together.

**The upgrade flow lives in `upgrade.js`** (`createUpgradeHandler`, unit tested in
`upgrade.test.js`, both with stubs and wired to the real `access.js` functions with signed
tickets). `server.js` only injects the dependencies. Order: socket `error` listener →
`takeCredential` → `stripCollabPrefix` → doc-name check (**400**) → ticket present
(**401**) → `verifyTicket` (**401**) → burn the jti (**401** if already used) →
`ticketIdentity` (**403** if no usable `user_id`/`iat`) → `fetchCurrentRole` (**503** if
the API can't answer) → role allowed (**403**) → accept.
1. **`verifyTicket`** (`access.js`) checks the signature, issuer (`PASETO_ISSUER`),
   audience, `token_type: ws_ticket`, expiry, jti/exp presence, and that `doc` equals the
   URL's doc name. The public key comes from `PASETO_V4_PUBLIC_PEM_FILE`
   (`/run/secrets/public.pem`). `PASETO_AUDIENCE` / `PASETO_ALLOWED_AUDIENCES` are ignored
   now, and a startup warning says so.
2. **`TicketReplayGuard`** (`access.js`) burns the jti: **single use**, so a ticket a
   proxy logged can't open a second socket. It's burned before the role lookup, so a
   failed lookup can't be retried with it (the client fetches a fresh ticket on
   reconnect). It's in memory, which assumes **one collab server process**. That already
   holds, because y-websocket keeps live docs in memory. A jti is kept until its ticket's
   `exp` + the 5s clock tolerance, the whole time `verifyTicket` could still accept it.
3. **`fetchCurrentRole`** calls
   `GET ${INTERNAL_API_URL}/internal/users/<user_id>/role?issued_at=<iat unix>` with
   `Authorization: Bearer ${ROLE_LOOKUP_SECRET}`. That endpoint is on the API's
   **separate internal listener** (`:8081`, never published), not the public `/api/v1`
   (`api/internal_routes.go`). **The ticket never leaves this process.**

**Decision: #223 + #233 merged (2026-10).** Two PRs replaced the old "forward the
client's token to `/users/me`" check in parallel:
- #223 (internal role lookup by `user_id`/`iat` with a shared secret);
- #233 (single-use tickets that the API redeemed at a public `POST /collab/tickets/redeem`,
  which burned the jti in an API-side replay guard and returned the role).

The merge keeps #223's lookup and #233's tickets, and moves the single-use burn into this
process. So the API only mints tickets, the redeem endpoint is gone, and no API route ever
accepts a ticket. Rejected alternatives:
- (a) Move redeem to the internal listener: more Go code, and the ticket still travels to
  the API.
- (b) Keep both: two API round trips and duplicate role/password checks per connect.
- (c, from #223) B, the API accepting the WS audience on `/users/me`: leaks WS knowledge
  into the API middleware and makes the ticket usable against an API route.

If Hocuspocus (#206) lands, keep this lookup and call it from `onAuthenticate`.

**Role check (#216).** Only **admins and editors** are admitted. This mirrors
`requireContentEditor` in `api/auth_roles.go`, so keep the role lists in sync.
- Tickets carry no `role` claim, and access is never decided from token contents. The
  role always comes from the DB via the internal endpoint.
- **401:** a missing, invalid, expired, wrong-type, other-doc or already-used ticket.
- **403:**
  - a contributor;
  - a deleted user (API 404);
  - a ticket without a usable `user_id`/`iat`;
  - a ticket issued before the user's latest password change. The API applies the same
    `issuedBeforePasswordChange` cutoff as `authMiddleware` and answers 403.

  Only new upgrades are checked, so an already-open socket survives the change.
- **503:** the API is down, slow (3s timeout), returns 5xx, or rejects the shared secret
  (401 means misconfiguration, not a user problem). It fails closed either way.
- `INTERNAL_API_URL` and `ROLE_LOOKUP_SECRET` are required. The server `exit(1)`s at
  startup without either. `API_URL` (the public `/api/v1`) is no longer used. The API's
  `NewServer` also refuses to start without `ROLE_LOOKUP_SECRET`; both sides must hold
  the same value (both trim it). Docker sets `INTERNAL_API_URL=http://api:8081` and the
  secret in `compose.dev.yaml`.
- `access.js` imports `paseto` but must never import yjs (single-instance rule below).
- Known limitation: the role is checked **only at connect**. An editor demoted mid-session
  keeps their open socket until it reconnects (REST saves are already blocked). Revisit
  with Hocuspocus `onAuthenticate` (#206).
- The admin SPA opens the editor `readOnly` for contributors (`canEditContent` in
  `web/gl-admin/lib/roles.ts`), so they never attempt the connection.
- **Never log the raw upgrade request (#220).** The ticket is in the URL. It's single use,
  but an unused one is still a credential for 30s, so don't log `req.url`,
  `req.headers`, the query params or the credential.
  - The upgrade handler calls `takeCredential(req)` (`access.js`) **first**. It reads
    `ticket` and strips the query from `req.url`, so nothing downstream
    (y-websocket, the connection handler, logs) ever sees the token.
  - Log doc names via `docNameForLog`, and client context (origin, UA, peer IP) via
    `upgradeContextForLog`, both in `logsafe.js`. The context is logged **only on
    rejected upgrades**, to avoid retaining IPs for every connect.
  - `log-guard.test.js` scans every log call (`console.*`, `console[level]`,
    `collabDebug`, `process.std{out,err}.write`) in every non-test module. It fails on
    `req` (anything but `req.auth`, including the whole object), `socket`,
    `searchParams`, `credential`, `token`, `params` and `url`, and on aliasing `console`
    methods. Arguments passed to `docNameForLog`/`upgradeContextForLog` are exempt. A
    value renamed through another variable still slips past it; the `takeCredential`
    strip is the real guarantee.
- **Doc names must be `post-<id>`** (`isCollabDocName`). The upgrade answers anything
  else with **400** before auth, and so does the squash endpoint, which also answers 400
  to a malformed `%` escape instead of throwing. So every doc name this process logs or
  stores is valid, and post-auth logs print `docName` directly.

## Persistence (LevelDB safety net)

- `setPersistence` (`bindState`/`writeState`) backs each doc with `y-leveldb` at
  `DATA_PATH` (Docker: `/data/yjs`, volume `ws_data`). The Postgres `block_doc` is the
  **canonical** store; LevelDB only protects in-flight Yjs state across restarts.
- On (re)connect, `bindState`:
  1. registers the per-update persistence listener **first** (before the async load) so
     no update that arrives mid-load is lost — a gap would corrupt the log;
  2. calls `evaluatePersistedState(ldb, docName)` (in `persistence.js`) which returns
     `apply` (clean → merge with sentinel origin `leveldb-restore`), `clear`
     (gapped/corrupt → `clearDocument`, quarantine), or `skip` (read error);
  3. applies the restored update tagged with `PERSISTENCE_ORIGIN` so the listener
     doesn't re-persist it (and reconnects don't re-write the snapshot).
- **`persistence.js` is the extracted, unit-tested decision logic** (`persistence.test.js`,
  `node --test`). Test it there, not by hand.

## Squash-on-publish

`POST /_internal/documents/:docName/squash` (auth: `Authorization: Bearer <SQUASH_SECRET>`)
merges the LevelDB update log into one snapshot. Called best-effort by the Go API after
publish (`triggerCollabSquash`). `DATA_PATH` and `SQUASH_SECRET` come from
`websocket/.env` (Docker overrides `DATA_PATH` via the compose `environment:` block).

## Gotchas (learned the hard way)

- **ONE yjs INSTANCE, not just one copy (THE root cause of the editor data-loss saga).**
  A single deduped `node_modules/yjs` is NOT enough: yjs and y-leveldb ship dual
  ESM+CJS builds, and `y-websocket/bin/utils` is CJS (`require("yjs")` → `yjs.cjs`)
  while this package is ESM (`import "yjs"` → `yjs.mjs`) — the same package evaluated
  TWICE with separate class registries. Cross-instance calls (`Y.applyUpdate` from the
  ESM build onto the CJS `WSSharedDoc` in bindState) fail yjs's internal constructor
  checks and silently corrupt the doc: it "wedges" (stops integrating a client's updates
  — structural edits like Enter-splits or paragraph→heading trigger it) and the client's
  2s resync then erases the user's typed content. The tell: yjs prints
  **"Yjs was already imported. This breaks constructor checks…"** at startup (yjs#438).
  Therefore `server.js`/`persistence.js`/tests load yjs + y-leveldb + bin/utils via
  `createRequire` (all CJS, one instance), and `server.js` has a startup probe that
  `process.exit(1)`s if a doc from bin/utils isn't `instanceof` our `Y.Doc`. Never
  revert these to bare ESM imports, and treat that startup warning as a release blocker.
- **`ldb.destroy()` does NOT delete data** — it's poorly named; it calls
  `db.close()`. The destructive method is `clearAll()`. Calling `destroy()` on shutdown
  is correct (a reviewer flagged it as wiping data — it doesn't).
- `encodeStateAsUpdate(doc)` **preserves** pending/gapped structs through encode+decode,
  so the corruption probe is reliable whether you check the source doc or a rebuilt one.
- `DATA_PATH` is trimmed then defaulted to `./data` (so `" "` → `./data`, not CWD).
- New env vars in `.env` need the container **recreated** (`docker compose up -d`), not
  just `restart`, to take effect. `.env` is gitignored.

## Debugging reconnects

Set `COLLAB_DEBUG=1`; `server.js` logs `bindState` decisions + live doc length,
timestamped to align with the browser's `GL_DEBUG_COLLAB` logs. Restart this container
mid-edit to reproduce reconnect scenarios:
`docker compose -f compose.dev.yaml restart websocket`.
</content>
