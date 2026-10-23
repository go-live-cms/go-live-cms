# Backups, restore and migrations

Runbook for operating a GoLive CMS deployment: what to back up, how to restore it,
and how schema migrations run in production. The scripts live in
[`scripts/backup/`](../../scripts/backup/); the restore path is tested end to end by
`scripts/backup/test-restore.sh` (also run in CI).

## What holds state

| Data | Where | Canonical? | Backed up by |
|------|-------|------------|--------------|
| Users, posts (`block_doc`, `published_block_doc`, versions), media rows, taxonomies, settings, themes, sessions | Postgres (`postgres_data` volume) | **Yes** | `db.dump` (pg_dump custom format) |
| Uploaded media files | `UPLOAD_PATH` (`/app/uploads/media`, `uploads` volume) | **Yes** | `media.tar.gz` |
| Live Yjs state of editor documents (Hocuspocus, since #284) | Postgres `post_ydoc_state` | No: `block_doc` is canonical, and a missing or stale row reseeds from it | `db.dump` (it's a table) |
| Live Yjs state before the Hocuspocus cutover (#284; dev rollback only until P5) | websocket `DATA_PATH` LevelDB (`ws_data` volume) | No, a safety net | `leveldb.tar.gz` (optional) |
| Secrets: `app.env`, PASETO keys, `websocket/public.pem`, `ROLE_LOOKUP_SECRET`, `COLLAB_INTERNAL_SECRET` | host / secret store | Yes | **Not** by these scripts. Keep them in your secret manager. Without the PASETO keys a restore still works, but every session is invalidated. |
| Theme sources (`web/themes`) | git | Yes | git |

Postgres and the media directory must be backed up **together**: media rows store the
file's absolute path under `UPLOAD_PATH`, and a row without its file is a broken image.
LevelDB is not needed for a correct restore: an editor that opens a document whose
LevelDB state is empty seeds it from Postgres `block_doc`. Since the Hocuspocus cutover
([collab-cutover.md](collab-cutover.md)) production has no LevelDB at all; the collab
server keeps its Yjs state in Postgres, so `db.dump` covers it.

## Backing up

`scripts/backup/backup.sh` is POSIX sh and needs `pg_dump`, `psql`, `tar`, `gzip` and
`sha256sum`. The `postgres:12-alpine` image has all of them, so the simplest way to run
it is a throwaway container on the compose network. It reads everything from the
environment; keep the connection string in an env file readable only by root, not in a
crontab or on the command line:

```sh
# /etc/golive/backup.env  (chmod 600)
DB_SOURCE=postgresql://root:<password>@postgres:5432/golive_cms?sslmode=disable
BACKUP_DIR=/backups
MEDIA_DIR=/app/uploads/media
RETAIN=48
```

```sh
docker run --rm --network golive_cms_default --env-file /etc/golive/backup.env \
  -v golive_cms_uploads:/app/uploads:ro \
  -v /srv/golive-backups:/backups \
  -v /srv/golive/scripts/backup:/scripts:ro \
  postgres:12-alpine sh /scripts/backup.sh
```

To also snapshot the collab server's LevelDB, mount its volume and set `WS_DATA_DIR`
(e.g. `-v golive_cms_ws_data:/data/yjs:ro -e WS_DATA_DIR=/data/yjs`). On a host with the
Postgres 12+ client tools the script runs directly as well (`sh scripts/backup/backup.sh`).

Each run writes one set, `golive-<UTC timestamp>/`, holding `db.dump`, `media.tar.gz`,
the optional `leveldb.tar.gz`, `backup.info` (schema migration version, server and
pg_dump versions) and `SHA256SUMS`. The set is built as `<name>.partial` and renamed
only when every step succeeded. After that the oldest sets beyond `RETAIN` are deleted.
Any failure exits non-zero and removes the partial set, so a cron/systemd wrapper can
alert on the exit code.

**Consistency.** `pg_dump` takes a single-transaction snapshot, so the database dump is
consistent while the site stays online; no downtime is needed. The media archive is
taken right after the dump. Media files are write-once, so uploads during the archive
only add unreferenced files. The rare file deleted between the dump and the archive
leaves a row whose file is missing. LevelDB is copied while the server writes to it, so
the snapshot can be torn; the websocket server detects a broken log on load and clears
it (`evaluatePersistedState`), and the editor then reseeds from Postgres.

`MEDIA_DIR` is required (set `SKIP_MEDIA=1` for a database-only backup) so that a typo
can't silently produce backups without media.

### How often

| What | Recommended | Why |
|------|-------------|-----|
| Database + media | **Hourly** for a site with daily editing, at least **daily** otherwise | The dump of a CMS-sized database takes seconds; the interval *is* your data-loss window (RPO). |
| Retention | `RETAIN=48` hourly locally, plus daily sets kept 30 days and monthly sets kept 12 months off-host | Lets you go back past a bad edit or a bug that silently corrupted content days ago. |
| LevelDB | Optional, daily is plenty | Only in-flight editor state that the 2s autosave has not written to Postgres yet. |
| Restore test | Monthly, and after every Postgres major upgrade | An untested backup is a hope. |

Example crontab (hourly, with an alert on failure; `notify-ops` is whatever you use):

```cron
7 * * * * /srv/golive/bin/run-backup.sh >>/var/log/golive-backup.log 2>&1 || notify-ops "golive backup failed"
```

Also alert when the newest set in the backup directory is older than about two
intervals, which catches a cron that stopped running at all.

### Off-host storage

A backup on the same disk as the database protects against bad edits, not against
losing the host. After each run, copy the new set off-host:

- Object storage in a **different account or provider** than the server (S3, B2, R2,
  GCS), with versioning and, if available, object lock / retention so a compromised
  host can't delete its own backups. `rclone copy`, `aws s3 sync` or `restic backup`
  all work on the set directory.
- **Encrypt before upload** (restic does this; otherwise `age` or `gpg`). The dump
  contains password hashes, emails and refresh-token hashes.
- Verify the copy: `restic check`, or download a set and run `sha256sum -c SHA256SUMS`.

## Restoring

`scripts/backup/restore.sh [--force] [--with-leveldb] <set-dir>` restores a set into a
**fresh** database and **empty** media directory. Before it changes anything it:

1. verifies `SHA256SUMS`, so a truncated or damaged set is rejected up front;
2. checks every target and **refuses** if the database has any table or `MEDIA_DIR` /
   `WS_DATA_DIR` has any file. `--force` replaces them instead: it drops the `public`
   schema and empties the directories. Prefer a new database.

The dump is first rendered to SQL in `$TMPDIR` (needs about the uncompressed size of
the database), then the `--force` schema reset and the whole restore run in **one**
transaction: any error rolls back to the database exactly as it was. Ownership and
grants are not restored; objects belong to the `DB_SOURCE` user, which does not need
to be a superuser (it must own the database).

LevelDB: by default `WS_DATA_DIR` (if set) is left **empty**, so every document reseeds
from the restored `block_doc`. That is the safe choice. `--with-leveldb` restores the
set's snapshot instead. **Never** restore the database while keeping a *newer* LevelDB:
the editor treats LevelDB as the live state, and the first autosave would write that
newer (or possibly corrupt) state over the restored `block_doc`.

### Disaster recovery, step by step

1. **Stop writers:** `docker compose stop api websocket web`.
2. **Pick the set** (newest good one; copy it back from off-host if needed) and check
   its `backup.info`: the schema migration version must be ≤ the version the API image
   you will run knows about.
3. **Fresh targets.** New host: `docker compose up -d postgres` creates an empty
   database. Existing host: either create a new database and point `DB_SOURCE` at it
   (`docker compose exec postgres createdb -U root golive_cms_restored`), or plan to use
   `--force`.
4. **Restore**, with the same volumes the API and websocket server use:

   ```sh
   docker run --rm --network golive_cms_default --env-file /etc/golive/backup.env \
     -e WS_DATA_DIR=/data/yjs \
     -v golive_cms_uploads:/app/uploads \
     -v golive_cms_ws_data:/data/yjs \
     -v /srv/golive-backups:/backups:ro \
     -v /srv/golive/scripts/backup:/scripts:ro \
     postgres:12-alpine sh /scripts/restore.sh /backups/golive-20261022T030700Z
   ```

   Add `--force` only when you mean to delete what is there.
5. **Start** `docker compose up -d`. The API runs any pending migrations on start (see
   below), and refuses to start if a dev seeded account still has its seeded password.
6. **Verify:**
   - `docker compose logs api` shows the migrations and `/health` answers;
   - row counts look right: `SELECT count(*) FROM posts; SELECT count(*) FROM media;`;
   - open a few posts in the admin, including one edited shortly before the backup, and
     the public site;
   - an image from the media library loads (`/uploads/media/<file>`).

### What we can promise (RPO / RTO)

- **RPO (data you can lose): one backup interval**, so ≤ 1 hour with hourly backups or
  ≤ 24 hours with daily ones, plus any typing the editor had not autosaved yet (2s
  debounce). There is no WAL archiving, so there is no point-in-time recovery between
  sets. If minutes matter, add continuous WAL archiving (pgBackRest or WAL-G) on top;
  these scripts stay useful as the simple, portable layer.
- **RTO (time to be back up): about 1 hour** for a single-host deployment, assuming the
  operator has this runbook, access to the off-host copy and the secrets. The restore
  itself is fast (the CI fixture restores in seconds; a CMS database of a few hundred
  MB in minutes). The real time goes to provisioning a host, fetching the set and
  checking the result. Media size dominates on large sites; budget for downloading it.

These hold only if backups are monitored and a restore is rehearsed, which is what
`test-restore.sh` and the monthly restore test are for.

## Testing the restore

```sh
sh scripts/backup/test-restore.sh      # KEEP=1 to leave the stack up for poking
```

It runs on its own compose project (`golive_restore_test`: tmpfs database, its own
volumes, no published ports), so it never touches the dev stack. It migrates up, down
and up again; loads fixture data (250 posts with `block_doc`, a media row and file, a
LevelDB file); takes three backups with `RETAIN=2`; checks that failed backups exit
non-zero and leave nothing behind; checks that restore refuses a non-empty database and
a damaged set; drops the database and deletes the media; restores; and compares every
table's row count, a hash of all `block_doc`s, one post's `block_doc` and the media
file's sha256. It also restores as a non-superuser into its own database, and checks
that a `--force` restore which fails after dropping the schema rolls back to the old
data. Finally it starts the real API in release mode on the restored data and
checks that it serves the media file byte for byte and the restored post and media rows.
CI runs it in the `backup-restore` job.

## Migrations

- Files: `db/migration/NNNNNN_name.{up,down}.sql`, applied by
  [golang-migrate](https://github.com/golang-migrate/migrate) v4.16.2 (the version in
  the API image and CI). Applied state is the `schema_migrations` table
  (`version`, `dirty`).
- **Production applies them automatically.** The API image's entrypoint (`start.sh`)
  runs `migrate up` before starting the server, on every container start, and exits if
  it fails, so the API never runs against a half-migrated schema. golang-migrate takes a
  Postgres advisory lock, so several API containers starting together are safe. Dev
  does the same in `start-dev.sh`.
- **CI** applies all migrations up, all the way down and up again on an empty database
  (`test-restore.sh`), so every down migration is at least executable.

### Deploying a release that adds migrations

CD does steps 2–4 for you (`scripts/deploy/deploy.sh`: backup, `migrate up` with the new
image before the new API starts, health wait); see [deploy.md](deploy.md). By hand:

1. See what's new: `git diff --stat <deployed-tag>..<new-tag> -- db/migration`.
2. **Take a backup right before deploying** (run `backup.sh` by hand). Down migrations
   are schema-only and lossy: `000004` down drops `block_doc` and every post version,
   `000005` down brings back an empty `content` column. The way back from a bad
   migration is restoring this backup, not `migrate down`.
3. Deploy (`docker compose up -d --build api`) and watch `docker compose logs -f api`
   for the `migrate` output.
4. Check the version: `docker compose exec postgres psql -U root -d golive_cms -c
   'SELECT * FROM schema_migrations'`.

To run migrate by hand with the API image (status, or applying before a deploy):

```sh
docker compose run --rm --entrypoint sh api -c '/app/migrate -path /app/migration -database "$DB_SOURCE" version'
```

### A failed migration (`dirty=true`)

The API container exits on start and `schema_migrations.dirty` is `true`: the migration
at that version failed partway. golang-migrate will not continue until told what state
the schema is in. Postgres runs each migration file in a transaction only if the file
makes it one, so check by hand what was applied. Then either finish or undo it manually
and mark the result with `migrate ... force <version>` (the version the schema now
matches), or restore the pre-deploy backup. Never `force` without checking.

### Seed data

- **Reference data is in migrations** and exists in every environment: the default
  post types and taxonomy types (`000001`), the settings row (`000006`), and the default
  theme and its settings (`000007`).
- **Dev seed data is not a migration.** The default admin (`admin`/`123456`) and the
  dummy users/posts are created by `devModeUtil` at API startup **only when
  `GIN_MODE=debug`** (`shouldSeedDevData`, #228/#231). Only `compose.dev.yaml` sets
  debug; `GIN_MODE` defaults to release and `compose.yaml` sets release explicitly.
- **Guard (#237/#241):** outside debug mode the API **refuses to start** while any
  seeded account (`admin`/`123456`, or `editor`/`author`/`contributor`/`moderator` with
  `password123`) still has its seeded password, or if it can't check. Restoring a dump
  from a deployment that once ran in debug mode trips it; the fix is in the readme,
  "Seeded dev accounts in production". Both gates are unit tested in
  `api/server_mode_test.go`.

## Upgrading a `compose.yaml` deployment from before #141

`compose.yaml` used to give Postgres no named volume and the API no uploads volume, so
the database sat in an anonymous volume and uploads in the container's writable layer.
Both now use named volumes (`postgres_data`, `uploads`). Switching an existing
deployment to the new file starts with **empty** volumes, so migrate the data across:

1. With the **old** stack still running, copy the media out of the API container
   (`/app/uploads/media` unless your `app.env` set another `UPLOAD_PATH`):
   `docker compose cp api:/app/uploads/media ./media-before-141`.
2. Still on the old stack, run `backup.sh` as shown above, but mount
   `./media-before-141` as `/app/uploads/media` instead of the `uploads` volume.
3. `docker compose down` (**without** `-v`, so the old anonymous volume survives as a
   fallback), switch to the new `compose.yaml`, `docker compose up -d postgres`, and
   restore the set (step 4 of the disaster recovery) into the new volumes.
4. `docker compose up -d` and verify as in step 6.
