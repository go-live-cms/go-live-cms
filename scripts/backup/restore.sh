#!/bin/sh
# Restore a GoLive CMS backup set made by backup.sh.
#
#   restore.sh [--force] [--with-leveldb] <backup-set-dir>
#
# Restores into a FRESH database and an EMPTY media directory. Before touching
# anything it verifies the set's checksums and checks every target; if the
# database has any tables, or MEDIA_DIR / WS_DATA_DIR has any files, it refuses
# and changes nothing. --force replaces them instead: it DROPS the public schema
# and empties the directories first. Prefer restoring into a new database.
#
# Configuration (environment only):
#   DB_SOURCE     postgres URL of the TARGET database (or the libpq PG* variables).
#                 The database must exist (createdb); restore.sh creates its contents.
#   MEDIA_DIR     target for the media archive; must match the API's UPLOAD_PATH
#                 (media rows store absolute paths under it). Required unless the
#                 set has no media or SKIP_MEDIA=1.
#   WS_DATA_DIR   optional: the websocket server's DATA_PATH. Without --with-leveldb
#                 it is only checked/emptied, so every document reseeds from the
#                 restored Postgres block_doc (recommended). With --with-leveldb the
#                 set's LevelDB snapshot is extracted there.
#
# Stop the API and websocket server before restoring into the live targets.
# See docs/operations/backups.md.

set -eu

FORCE=0
WITH_LEVELDB=0
SET_DIR=
SKIP_MEDIA=${SKIP_MEDIA:-0}
MEDIA_DIR=${MEDIA_DIR:-}
WS_DATA_DIR=${WS_DATA_DIR:-}

log() { printf '%s restore: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
usage() { echo "usage: $0 [--force] [--with-leveldb] <backup-set-dir>" >&2; exit 2; }

while [ $# -gt 0 ]; do
	case $1 in
		--force) FORCE=1 ;;
		--with-leveldb) WITH_LEVELDB=1 ;;
		-h | --help) usage ;;
		-*) echo "unknown option: $1" >&2; usage ;;
		*) [ -z "$SET_DIR" ] || usage; SET_DIR=$1 ;;
	esac
	shift
done
[ -n "$SET_DIR" ] || usage
[ -d "$SET_DIR" ] || die "'$SET_DIR' is not a directory"

for tool in pg_restore psql tar gzip sha256sum; do
	command -v "$tool" >/dev/null 2>&1 || die "'$tool' not found in PATH"
done

pg() {
	cmd=$1
	shift
	if [ -n "${DB_SOURCE:-}" ]; then
		"$cmd" --dbname="$DB_SOURCE" "$@"
	else
		"$cmd" "$@"
	fi
}
sql() { pg psql -X -A -t -v ON_ERROR_STOP=1 -c "$1"; }

# A path we would empty with --force must be a real, non-root directory.
check_target_dir() {
	case $1 in
		'' | / | /. | /.. | . | ..) die "refusing to use '$1' as a restore target" ;;
	esac
}
dir_is_empty() { [ ! -d "$1" ] || [ -z "$(ls -A "$1")" ]; }
empty_dir() { find "$1" -mindepth 1 -maxdepth 1 -exec rm -rf {} + ; }

# --- 1. Verify the backup set -------------------------------------------------
[ -f "$SET_DIR/SHA256SUMS" ] || die "$SET_DIR has no SHA256SUMS; not a complete backup set"
[ -f "$SET_DIR/db.dump" ] || die "$SET_DIR has no db.dump"
log "verifying checksums in $SET_DIR"
(cd "$SET_DIR" && sha256sum -c SHA256SUMS >/dev/null) || die "checksum mismatch: the backup set is damaged"
[ ! -f "$SET_DIR/backup.info" ] || sed 's/^/  /' "$SET_DIR/backup.info" >&2

has_media=0
[ -f "$SET_DIR/media.tar.gz" ] && has_media=1
if [ "$has_media" = 1 ] && [ "$SKIP_MEDIA" != 1 ]; then
	[ -n "$MEDIA_DIR" ] || die "the set contains media: set MEDIA_DIR to the API's UPLOAD_PATH (or SKIP_MEDIA=1)"
	check_target_dir "$MEDIA_DIR"
else
	MEDIA_DIR=
fi
if [ "$WITH_LEVELDB" = 1 ]; then
	[ -n "$WS_DATA_DIR" ] || die "--with-leveldb needs WS_DATA_DIR"
	[ -f "$SET_DIR/leveldb.tar.gz" ] || die "--with-leveldb given but the set has no leveldb.tar.gz"
fi
[ -z "$WS_DATA_DIR" ] || check_target_dir "$WS_DATA_DIR"

# --- 2. Safety checks: refuse to overwrite anything without --force -----------
tables=$(sql "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')") ||
	die "cannot connect to the target database (does it exist?)"
refuse=
[ "$tables" -eq 0 ] || refuse="$refuse
  - the target database has $tables table(s)"
if [ -n "$MEDIA_DIR" ] && ! dir_is_empty "$MEDIA_DIR"; then
	refuse="$refuse
  - MEDIA_DIR $MEDIA_DIR is not empty"
fi
if [ -n "$WS_DATA_DIR" ] && ! dir_is_empty "$WS_DATA_DIR"; then
	refuse="$refuse
  - WS_DATA_DIR $WS_DATA_DIR is not empty"
fi
if [ -n "$refuse" ]; then
	if [ "$FORCE" != 1 ]; then
		die "refusing to overwrite existing data:$refuse
Restore into a new database / empty directories, or pass --force to DELETE it first."
	fi
	log "--force: replacing existing data:$refuse"
fi

# --- 3. Database --------------------------------------------------------------
if [ "$tables" -ne 0 ]; then
	log "--force: dropping and recreating schema public"
	sql "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null || die "cannot reset schema public"
fi
log "restoring database"
# One transaction: the database ends up either fully restored or untouched.
# Ownership/grants are not restored, so objects belong to the DB_SOURCE user.
pg pg_restore --exit-on-error --single-transaction --no-owner --no-privileges "$SET_DIR/db.dump" ||
	die "pg_restore failed; the target database was left without the restored data"

migration=$(sql "SELECT version || ' dirty=' || dirty FROM schema_migrations") ||
	die "restored database has no schema_migrations table"
log "database restored (schema migration $migration, $(sql 'SELECT count(*) FROM posts') posts)"
case $migration in
	*dirty=true) log "WARNING: the restored schema_migrations is dirty; fix it before starting the API" ;;
esac

# --- 4. Media -----------------------------------------------------------------
if [ -n "$MEDIA_DIR" ]; then
	mkdir -p "$MEDIA_DIR"
	dir_is_empty "$MEDIA_DIR" || empty_dir "$MEDIA_DIR"
	log "extracting media into $MEDIA_DIR"
	tar -C "$MEDIA_DIR" -xzf "$SET_DIR/media.tar.gz" || die "media extraction failed"
elif [ "$has_media" = 1 ]; then
	log "SKIP_MEDIA=1: media not restored"
fi

# --- 5. Collab LevelDB --------------------------------------------------------
if [ -n "$WS_DATA_DIR" ]; then
	mkdir -p "$WS_DATA_DIR"
	dir_is_empty "$WS_DATA_DIR" || empty_dir "$WS_DATA_DIR"
	if [ "$WITH_LEVELDB" = 1 ]; then
		log "extracting LevelDB snapshot into $WS_DATA_DIR"
		tar -C "$WS_DATA_DIR" -xzf "$SET_DIR/leveldb.tar.gz" || die "LevelDB extraction failed"
	else
		log "WS_DATA_DIR left empty: documents reseed from the restored block_doc"
	fi
fi

log "done. Start the API (it runs pending migrations) and check the runbook's verification steps."
