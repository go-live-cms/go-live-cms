# WebSocket collaboration server — agent context

Node, ESM (`"type": "module"`). A `y-websocket` server with **PASETO v4.public** auth
and **LevelDB** persistence. Port 1234. Entry: `server.js`. Dev: `npm run dev`
(nodemon). Tests: `npm test` (`node --test`).

## Auth

Clients connect with `ws://…:1234/post-<id>?ticket=<v4.public token>`. The token is the
**same** PASETO the Go API issues. Verified during the HTTP upgrade (issuer `golive.auth`;
audiences `golive.admin-ws`, `golive.admin`, `golive.auth`). Public key loaded from
`PASETO_V4_PUBLIC_PEM_FILE` (`/run/secrets/public.pem`).

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

- **`yjs` is a direct dependency** of this package (server.js does `import * as Y`).
  Keep it direct + a single deduped copy — two yjs instances cause
  `integrateStructs`/`splice` corruption.
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
