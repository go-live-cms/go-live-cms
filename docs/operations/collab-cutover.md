# Collab server: Hocuspocus (after the y-websocket cutover)

The collaborative editor runs on the Hocuspocus server (`web/collab-server/`, the `collab`
service), which keeps each post's live Yjs state in Postgres (`post_ydoc_state`) and is the
only writer of `posts.block_doc` for an existing post.

History: #206 moved the editor off the y-websocket server (`websocket/`, Yjs state in
LevelDB, each client's REST autosave through `PUT /posts/:id/blocks`). P4 (#284) made
Hocuspocus the default behind a `COLLAB_BACKEND` / `PUBLIC_COLLAB_BACKEND` flag pair with a
y-websocket rollback; P5 (#285) deleted y-websocket, the flag, `PUT /posts/:id/blocks` and
the LevelDB tooling. **There is no y-websocket rollback any more.** A problem with the
collab server is fixed forward.

## What protects the content

- **Only the collab server writes `block_doc`** (`PUT /internal/posts/:id/collab`), together
  with the Yjs state, in one transaction. The client never seeds and never saves content.
- **Revision guard.** `post_ydoc_state` records the `posts.block_revision` it was stored at.
  If anything else changes `block_doc` (a restored backup, a manual fix), the revision moves
  on, the API withholds the stale state, and the server reseeds the doc from `block_doc`.
- **Epoch guard.** Every seeding gets a new `meta.epoch`. A tab that synced an older epoch
  is refused with `stale-epoch` and remounts on a fresh doc, instead of merging old structs
  back in (which would duplicate the content).
- **Publish flushes first.** The API asks the collab server to store the doc
  (`POST /internal/documents/post-<id>/flush`) and answers 503 if it can't, so a published
  snapshot never misses the last debounced edits.

## Forcing a reseed

Emptying `post_ydoc_state` makes every doc seed fresh from `block_doc` on its next open,
under a new epoch. It is safe whenever no editor is open (the worst case is a reseed):

```sh
docker compose -f compose.dev.yaml exec -T postgres psql -U root -d golive_cms -c "TRUNCATE post_ydoc_state"
```

Close every admin tab first, and restart `collab` afterwards so it drops any doc it still
holds in memory. One post only: `DELETE FROM post_ydoc_state WHERE post_id = <id>`.

## Verify

- `docker compose -f compose.dev.yaml ps`: `collab` is up (healthy).
- `docker compose -f compose.dev.yaml logs collab`, read **from the top**: one
  `collab_listening` with `"yjs_single_instance":true`, no "Yjs was already imported",
  nothing ticket-shaped (`v4.public.`).
- Open a post: the editor connects to `ws://<host>:1235` (production:
  `wss://<domain>/collab`), the collab log shows `collab_load ... "outcome":"seeded"` the
  first time, and after an edit `collab_store ... "block_doc":"written"` and the editor
  shows "Saved".
- Two logins (`localhost:4321` and `127.0.0.1:4321` have separate cookies): both see each
  other's edits and cursors; reload both; each edit appears once.
- Publish: the collab log shows `collab_flush`, and the public page has the edit.
- `docker compose -f compose.dev.yaml exec -T postgres psql -U root -d golive_cms -c
  "select post_id, block_revision, epoch from post_ydoc_state"` lists the posts you
  opened.
- No `collab_store_failed`, `collab_store_invalid`, `collab_store_unconvertible` or
  `collab_load_failed` that isn't explained.

## Removing the old dev volume

The y-websocket server's LevelDB lived in the dev `ws_data` volume, which nothing uses any
more. P5 removed it from `compose.dev.yaml` but not from your machine; delete it yourself
once you're sure you don't want it:

```sh
docker volume rm golive_cms_dev_ws_data
```

If you made the pre-rollback copy from the old runbook, remove it too:
`docker volume rm golive_cms_dev_ws_data_pre_rollback`. An isolated `-p` project has its
own `<project>_ws_data`.

## First production deploy

Production never ran y-websocket, so there is nothing to migrate:

1. Follow [deploy.md](deploy.md), "First-time VM setup". CD pushes
   `ghcr.io/go-live-cms/{api,web,collab}`, and `compose.yaml` runs `collab` behind Caddy's
   `/collab`, with the API's `COLLAB_INTERNAL_URL=http://collab:1236`.
2. Verify as above, through the site: `docker compose logs collab` from the top, an editor
   that says "Connected" (`wss://<domain>/collab`), "Saved" after an edit, and a publish
   that logs `collab_flush` and shows on the public page.

Rolling a deployment back is a redeploy of an older release ([deploy.md](deploy.md),
"Rollback"). Releases from #284 on run `collab` and need nothing else. Releases before #284
ran y-websocket; redeploying one is **unsupported**: its editor would need an empty
`ws_data` volume and would autosave over `block_doc` with no flush or guards.

## P5 (done)

Completed 2026-10-27 (#285), after the dev stack ran on Hocuspocus from 2026-10-23 with no
rollback, 11 stores and no store or load failures, and the bake's bugs (#304–#307) fixed.
