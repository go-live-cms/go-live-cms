# Collab cutover: y-websocket → Hocuspocus

Runbook for phase 4 of the Hocuspocus migration (#206, #284): switching the collaborative
editor from the y-websocket server (`websocket/`, LevelDB) to the Hocuspocus server
(`web/collab-server/`, Yjs state in Postgres `post_ydoc_state`), and back if needed.
Since #284, **Hocuspocus is the default** in `compose.dev.yaml`, `compose.yaml`, the API
config, the web build and CD.

## Where this applies today

**There is no production deployment yet.** CD builds and pushes images to GHCR, but its
deploy job is skipped (no VM, no `DEPLOY_ENABLED`). So:

- the only legacy Yjs state in existence is each developer's local dev `ws_data` volume
  (the default project's is `golive_cms_dev_ws_data`);
- the **first production deploy will start on Hocuspocus**: there is no LevelDB to diff,
  nothing to truncate, and no y-websocket deployment to roll back to (see
  [First production deploy](#first-production-deploy)).

The dev procedure below is therefore the real cutover. If a y-websocket deployment ever
does exist somewhere, the same steps apply to it, run on that host.

## How the two backends differ (what the steps protect)

| | y-websocket (before) | Hocuspocus (after) |
|---|---|---|
| Live Yjs store | LevelDB, `ws_data` volume | Postgres `post_ydoc_state` |
| Who writes `posts.block_doc` | each client's REST autosave (`PUT /posts/:id/blocks`) | only the collab server (`PUT /internal/posts/:id/collab`); `PUT /blocks` answers 409 |
| Who seeds a new doc | the first client, from `block_doc` | the server, from `block_doc`, with a new epoch |
| Flag | `COLLAB_BACKEND=y-websocket` (API) + `PUBLIC_COLLAB_BACKEND=y-websocket` (web build) | both `hocuspocus` (the default) |
| Dev port | :1234 (`websocket` service, profile `y-websocket`) | :1235 (`collab` service) |

- **The two flags always flip together.** They are deployment-wide; two backends serving
  one post would fork it. The protocols are incompatible, so **every open admin tab must
  reload** after a flip.
- **Hocuspocus never imports LevelDB.** It seeds each doc from `block_doc`. Anything that
  exists only in LevelDB (an autosave that never caught up) would be lost at the cutover.
  That is what the dry-run diff checks.
- **Rolling back needs `ws_data` cleared first.** Its LevelDB state predates whatever
  Hocuspocus wrote to `block_doc` since the cutover. The old client loads the LevelDB
  state when there is one, and its autosave would write that old content back over the
  newer `block_doc`.
- **Rolling forward again needs no clearing.** `post_ydoc_state` records the
  `block_revision` it was stored at. Any `block_doc` written around the collab server (the
  y-websocket autosave during a rollback) bumps the revision, so the API withholds the
  stale state and the server reseeds from `block_doc` under a new epoch.

## Dev cutover (your own `golive_cms_dev` stack)

Commands run from the repo root. The scripts are POSIX sh (Git Bash, WSL or Linux).

### 1. Dry run: diff LevelDB against Postgres (old stack still up)

With the old stack (main before #284) still running, at least `postgres`, and its `web`
and `websocket` images built:

```sh
sh scripts/collab/leveldb-diff-dev.sh            # project golive_cms_dev
```

It is read-only. It exports `block_doc` with a `SELECT`, mounts `ws_data` read-only and
compares a copy of it, in a throwaway container built from the project's `web` and
`websocket` images (`scripts/collab/leveldb-diff.mjs`, comparison in
`web/collab-server/leveldbDiff.ts`). Each LevelDB doc gets one status:

| Status | Meaning | Action |
|---|---|---|
| `match` | the fragment holds what Hocuspocus will seed from `block_doc` | none |
| `ids-differ` | same content, some block ids differ | none (Hocuspocus keeps `block_doc`'s ids) |
| `empty` | no editor content in LevelDB (only the old block maps, or nothing) | none |
| `no-post` | the post was deleted | none |
| `corrupt` | gapped update log (the old server would have discarded it too) | none |
| **`differs`** | LevelDB holds content `block_doc` lacks (or the reverse) | **resolve, below** |

Both sides are compared as the store would write them (block_doc → fragment →
block_doc), so seed-format docs that were opened but never saved compare by content.
Exit code 1 means at least one `differs`; the report is also written to
`scripts/collab/leveldb-diff-golive_cms_dev.json` (gitignored).

**Resolving a `differs`:** on the **y-websocket** path, open each listed post
(`/gl-admin/content/edit/<id>`) as an admin or editor, make a trivial edit (type and
delete a space), wait for "Saved", close it, and run the diff again until nothing
differs. Opening it loads the LevelDB state into the editor, and its autosave writes it
to `block_doc`. Use a checkout that includes #284 with the rollback flags
(`COLLAB_BACKEND=y-websocket COLLAB_INTERNAL_URL=http://websocket:1234`, profile
`y-websocket`, see [Dev rollback](#dev-rollback) step 4, but **without** clearing
`ws_data`): before #284 the y-websocket editor's autosave could silently stop in dev
(StrictMode created a second, never-initialized persistence manager), which is also how a
post can end up with content only in LevelDB. Check the API log shows `PUT
/api/v1/posts/<id>/blocks` 200. If what LevelDB holds is the *older* side (`block_doc`
was changed some other way), there is nothing to save; check the post and accept the
diff.

### 2. Switch

1. Close every admin tab.
2. Update the checkout to a main that includes #284, then:
   ```sh
   docker compose -f compose.dev.yaml --profile y-websocket stop websocket
   docker compose -f compose.dev.yaml up -d --build collab
   docker compose -f compose.dev.yaml up -d api web
   ```
   `up` picks up the new defaults (`COLLAB_BACKEND=hocuspocus`, `COLLAB_INTERNAL_URL=
   http://collab:1236`, `PUBLIC_COLLAB_BACKEND=hocuspocus`) and recreates `api` and `web`.
   The API runs pending migrations on start (`post_ydoc_state` is `000020`). Unset any
   `COLLAB_BACKEND` / `COLLAB_INTERNAL_URL` you exported in your shell or put in a root
   `.env`. The `websocket` service now sits behind the `y-websocket` profile, so a plain
   `up` no longer starts it.
3. **Truncate `post_ydoc_state`**, before opening any editor, so every doc seeds fresh from
   `block_doc` (it may hold rows from earlier Hocuspocus experiments, possibly at a
   revision that still matches):
   ```sh
   docker compose -f compose.dev.yaml exec -T postgres psql -U root -d golive_cms -c "TRUNCATE post_ydoc_state"
   ```
   This is a documented step, not a migration. It is safe at any time no editor is open:
   the worst case is a reseed under a new epoch.
4. **Keep the `ws_data` volume** through the rollback window. Don't `down -v`.
5. Reload the admin.

### 3. Verify

- `docker compose -f compose.dev.yaml ps`: `collab` is up (healthy), `websocket` is not
  running.
- `docker compose -f compose.dev.yaml exec api printenv COLLAB_BACKEND` → `hocuspocus`;
  `... exec web printenv PUBLIC_COLLAB_BACKEND` → `hocuspocus`.
- `docker compose -f compose.dev.yaml logs collab`, read **from the top**: one
  `collab_listening` with `"yjs_single_instance":true`, no "Yjs was already imported",
  nothing ticket-shaped (`v4.public.`).
- Open a post: the editor connects to `ws://<host>:1235`, the collab log shows
  `collab_load ... "outcome":"seeded"` the first time, and after an edit `collab_store
  ... "block_doc":"written"` and the editor shows "Saved".
- Two logins (`localhost:4321` and `127.0.0.1:4321` have separate cookies): both see each
  other's edits and cursors; reload both; each edit appears once.
- Publish: the collab log shows `collab_flush`, and the public page has the edit.
- `docker compose -f compose.dev.yaml exec -T postgres psql -U root -d golive_cms -c
  "select post_id, block_revision, epoch from post_ydoc_state"` lists the posts you
  opened.

## Dev rollback

Only if Hocuspocus misbehaves. Roll back first, investigate after.

1. Close every admin tab.
2. Stop the collab server. On SIGTERM it stores every open doc (state and `block_doc`):
   ```sh
   docker compose -f compose.dev.yaml stop collab
   ```
3. **Clear `ws_data` first.** Keep a copy if you want one, then remove it:
   ```sh
   docker run --rm -v golive_cms_dev_ws_data:/src:ro -v golive_cms_dev_ws_data_pre_rollback:/dst alpine cp -a /src/. /dst/
   docker compose -f compose.dev.yaml --profile y-websocket rm -sf websocket
   docker volume rm golive_cms_dev_ws_data
   ```
4. **Flip both flags back** and start the old server. Export them for the whole shell
   session (or put them in a root `.env`, which `compose.yaml` reads too), or a later plain
   `up` flips you forward again:
   ```sh
   export COLLAB_BACKEND=y-websocket COLLAB_INTERNAL_URL=http://websocket:1234
   docker compose -f compose.dev.yaml --profile y-websocket up -d api web websocket
   ```
   In PowerShell: `$env:COLLAB_BACKEND="y-websocket"; $env:COLLAB_INTERNAL_URL="http://websocket:1234"`,
   then the same `docker compose` line.
5. Reload the admin. The old editor finds LevelDB empty, seeds from `block_doc` (which
   has every Hocuspocus edit) and autosaves through `PUT /blocks` again.

Leave `post_ydoc_state` alone; it is harmless while the API is on y-websocket.

**Rolling forward again** is step 2 of the cutover without the truncate: stop
`websocket`, `unset COLLAB_BACKEND COLLAB_INTERNAL_URL`, `up -d api collab web`, reload.
Every post edited during the rollback has a newer `block_revision`, so its stored state
is withheld and the server reseeds it from `block_doc`. Posts nobody edited restore their
stored state, which still matches. No diff is needed: the y-websocket autosave kept
`block_doc` current.

## First production deploy

Production has never run y-websocket, so there is no cutover to do:

1. Follow [deploy.md](deploy.md), "First-time VM setup". CD pushes
   `ghcr.io/go-live-cms/{api,web,collab}` (the web image is built with
   `PUBLIC_COLLAB_BACKEND=hocuspocus`), and `compose.yaml` runs `collab` behind Caddy's
   `/collab`, with the API on `COLLAB_BACKEND=hocuspocus` and `COLLAB_INTERNAL_URL=
   http://collab:1236`. No `websocket` service, no `ws_data` volume.
2. Verify as above, through the site: `docker compose logs collab` from the top, an editor
   that says "Connected" (`wss://<domain>/collab`), "Saved" after an edit, and a publish
   that logs `collab_flush` and shows on the public page.

### Rollback (production)

Rolling a deployment back past #284 means redeploying a release from before it (Actions →
cd → Run workflow with that sha; [deploy.md](deploy.md), "Rollback"). Its images are on
GHCR, and its `compose.yaml` runs `websocket` with a `ws_data` volume again; no down
migration is needed (`000020` predates #284). Before deploying it:

1. Make sure `golive_cms_ws_data` doesn't exist or is empty
   (`docker volume rm golive_cms_ws_data` on the VM), for the reason in
   [How the two backends differ](#how-the-two-backends-differ-what-the-steps-protect).
2. Tell editors to close their tabs; reload after the deploy.

Rolling forward is a normal deploy of the newer sha; the revision guard reseeds.

### If a y-websocket deployment ever exists

Do the dev procedure on that host: run `leveldb-diff.mjs` against a copy of its
`ws_data` (`node scripts/collab/leveldb-diff.mjs --data <dir> --block-docs <posts.json>`;
the header of the script has the export query), resolve any `differs` on the old
release, then deploy a release with #284. The deploy replaces `websocket` with `collab`
(`--remove-orphans`) and leaves the `ws_data` volume on disk; truncate `post_ydoc_state`
before reopening the admin.

## When to proceed to P5

P5 deletes `websocket/`, the y-websocket client path, `PUT /posts/:id/blocks`, the squash
config and `ws_data`, after which there is no rollback. Go ahead when all of these hold:

- the dev stack has run on Hocuspocus for the rollback window (about a week of normal
  editing) without needing a rollback;
- the verification checks above still pass, and the `collab` logs show no
  `collab_store_failed`, `collab_store_invalid` or `collab_store_unconvertible` that
  wasn't explained;
- nothing still depends on `PUT /posts/:id/blocks` (it answers 409 under Hocuspocus, so
  any caller already fails loudly);
- you no longer want the `ws_data` volume (or its `_pre_rollback` copy): P5's runbook
  removes it.

Production doesn't gate P5: it has never run y-websocket.
