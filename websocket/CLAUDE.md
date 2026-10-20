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
`doc` claim, 30s TTL and a unique jti (`token/ws_ticket.go`). A ticket is not an API bearer
token (wrong audience and type). `takeCredential` reads only `?ticket=`. There is no
`?token=` / access-token fallback, because the editor and this server ship together.

**The upgrade flow lives in `upgrade.js`** (`createUpgradeHandler`, unit tested in
`upgrade.test.js` with a fake socket). `server.js` only injects the ticket check, the
redemption and `wss.handleUpgrade`. Order: socket `error` listener → `takeCredential`
→ `stripCollabPrefix` → doc-name check (**400**) → ticket present (**401**) →
`verifyTicket` (**401**) → `redeemTicket` (**503** if the API can't answer, **401** if
it refuses) → role allowed (**403**) → accept.
1. **`verifyTicket`** (`access.js`) checks the signature, issuer (`PASETO_ISSUER`),
   audience, type and expiry locally, and that `doc` equals the URL's doc name. The public
   key comes from `PASETO_V4_PUBLIC_PEM_FILE` (`/run/secrets/public.pem`).
   `PASETO_AUDIENCE` / `PASETO_ALLOWED_AUDIENCES` are ignored now, and a startup warning
   says so.
2. **`redeemTicket`** POSTs it to `${API_URL}/collab/tickets/redeem` (`Authorization:
   Bearer <ticket>`). The API burns the jti (**single use**). This is in memory, so it
   assumes one API process. The API also rejects tickets minted before a password change
   and returns the user's **current** role from the DB. Redemption is the role check.

**Role check (#216).** Only **admins and editors** are admitted. This mirrors
`requireContentEditor` in `api/auth_roles.go`, so keep the role lists in sync.
- Tickets carry no `role` claim, and access is never decided from token contents.
- A ticket the API refuses (used, expired, password changed, user deleted) gets **401**.
  A contributor gets **403**. If the API is down, slow (3s timeout) or returns 5xx, the
  upgrade gets **503**. It fails closed either way. The ticket is burned regardless, so
  the client's reconnect fetches a new one. Only new upgrades are checked, so an
  already-open socket survives a password change.
- A ticket logged by a proxy is useless once redeemed, which happens milliseconds after
  minting. The residual risk is a ticket whose upgrade never reached this server: it
  stays valid for at most 30s, for one document.
- `API_URL` is required. The server `exit(1)`s at startup without it. Docker sets it to
  `http://api:8080/api/v1`.
- Known limitation: the role is checked **only at connect**. An editor demoted mid-session
  keeps their open socket until it reconnects (REST saves are already blocked). Revisit
  with Hocuspocus `onAuthenticate` (#206).
- The admin SPA opens the editor `readOnly` for contributors (`canEditContent` in
  `web/gl-admin/lib/roles.ts`), so they never attempt the connection.
- **Never log the raw upgrade request (#220).** The ticket is in the URL. It's single use,
  but an unredeemed one is still a credential for 30s, so don't log `req.url`,
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
