#!/bin/sh
# Back up GoLive CMS: a consistent Postgres dump, the uploaded media, and
# (optionally) the collab server's LevelDB volume.
#
# Each run writes one timestamped backup set:
#
#   $BACKUP_DIR/golive-20261022T031500Z/
#     db.dump          pg_dump custom format (restore with restore.sh / pg_restore)
#     media.tar.gz     contents of MEDIA_DIR (unless SKIP_MEDIA=1)
#     leveldb.tar.gz   contents of WS_DATA_DIR (only when WS_DATA_DIR is set)
#     backup.info      when, which schema migration, tool versions
#     SHA256SUMS       checksums of the files above (restore.sh verifies them)
#
# The set is built in a ".partial" directory and renamed only when every step
# succeeded, so a failed run never leaves a set that looks complete or counts
# towards retention. Any failure exits non-zero.
#
# Configuration (environment only; nothing secret lives in this file):
#   DB_SOURCE     postgres URL, e.g. postgresql://user:pass@host:5432/golive_cms?sslmode=disable.
#                 If unset, the standard libpq PG* variables are used
#                 (PGHOST, PGUSER, PGDATABASE, PGPASSWORD or ~/.pgpass).
#   BACKUP_DIR    where backup sets go (default ./backups)
#   MEDIA_DIR     the API's UPLOAD_PATH directory (e.g. /app/uploads/media).
#                 Required unless SKIP_MEDIA=1, so media is never skipped by accident.
#   WS_DATA_DIR   optional: the websocket server's DATA_PATH (LevelDB) to snapshot
#   RETAIN        number of complete backup sets to keep (default 7, 0 = keep all)
#
# Needs: sh, pg_dump/pg_restore/psql no older than the server (the
# postgres:12-alpine image has everything), tar, gzip, sha256sum.
# See docs/operations/backups.md.

set -eu

BACKUP_DIR=${BACKUP_DIR:-./backups}
RETAIN=${RETAIN:-7}
SKIP_MEDIA=${SKIP_MEDIA:-0}
MEDIA_DIR=${MEDIA_DIR:-}
WS_DATA_DIR=${WS_DATA_DIR:-}

log() { printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

case $RETAIN in
	'' | *[!0-9]*) die "RETAIN must be a non-negative integer, got '$RETAIN'" ;;
esac

if [ "$SKIP_MEDIA" != 1 ]; then
	[ -n "$MEDIA_DIR" ] || die "MEDIA_DIR is not set (set it to the API's UPLOAD_PATH, or SKIP_MEDIA=1 to back up the database only)"
	[ -d "$MEDIA_DIR" ] || die "MEDIA_DIR '$MEDIA_DIR' is not a directory"
fi
if [ -n "$WS_DATA_DIR" ] && [ ! -d "$WS_DATA_DIR" ]; then
	die "WS_DATA_DIR '$WS_DATA_DIR' is not a directory"
fi

for tool in pg_dump pg_restore psql tar gzip sha256sum; do
	command -v "$tool" >/dev/null 2>&1 || die "'$tool' not found in PATH"
done

# psql/pg_dump with the configured connection. DB_SOURCE goes through --dbname
# so it never appears in our own output.
pg() {
	cmd=$1
	shift
	if [ -n "${DB_SOURCE:-}" ]; then
		"$cmd" --dbname="$DB_SOURCE" "$@"
	else
		"$cmd" "$@"
	fi
}

mkdir -p "$BACKUP_DIR"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
name="golive-$stamp"
final="$BACKUP_DIR/$name"
work="$final.partial"

[ ! -e "$final" ] || die "$final already exists"
mkdir "$work" || die "cannot create $work"

cleanup() {
	status=$?
	if [ "$status" -ne 0 ] && [ -d "$work" ]; then
		rm -rf -- "$work"
		log "removed incomplete $work"
	fi
	exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# 1. Database. pg_dump runs in one REPEATABLE READ transaction, so the dump is
# a consistent snapshot even while the API keeps writing. It goes first: media
# is write-once, so files uploaded while the archive runs only add orphans,
# never rows without files.
log "dumping database"
pg pg_dump --format=custom --compress=6 --file="$work/db.dump" ||
	die "pg_dump failed"
# A dump pg_restore can't list is useless; catch truncation now, not at restore.
pg_restore --list "$work/db.dump" >/dev/null || die "db.dump is not readable by pg_restore"

if migration=$(pg psql -X -A -t -v ON_ERROR_STOP=1 \
	-c "SELECT version || ' dirty=' || dirty FROM schema_migrations"); then
	[ -n "$migration" ] || {
		migration="none (schema_migrations is empty)"
		log "WARNING: schema_migrations is empty; this set records no schema version"
	}
else
	migration="unknown (schema_migrations unreadable)"
	log "WARNING: cannot read schema_migrations; this set records no schema version"
fi
server_version=$(pg psql -X -A -t -v ON_ERROR_STOP=1 -c "SHOW server_version") ||
	die "cannot query the server version"
case $migration in
	*dirty=true) log "WARNING: schema_migrations is dirty ($migration); a failed migration needs fixing" ;;
esac

# 2. Media.
if [ "$SKIP_MEDIA" = 1 ]; then
	log "SKIP_MEDIA=1: not backing up media"
else
	log "archiving media from $MEDIA_DIR"
	tar -C "$MEDIA_DIR" -czf "$work/media.tar.gz" . || die "media archive failed"
fi

# 3. Collab LevelDB (optional). It is only a safety net for in-flight Yjs state;
# Postgres block_doc is canonical. The live server may change files while tar
# reads them; a torn snapshot is detected and cleared by the server on load
# (evaluatePersistedState). GNU tar exits 1 for "file changed as we read it",
# which is expected here; 2 is a real failure.
if [ -n "$WS_DATA_DIR" ]; then
	log "snapshotting LevelDB from $WS_DATA_DIR"
	rc=0
	tar -C "$WS_DATA_DIR" -czf "$work/leveldb.tar.gz" . || rc=$?
	case $rc in
		0) ;;
		1) log "WARNING: LevelDB changed while archiving; the snapshot may be torn" ;;
		*) die "LevelDB archive failed" ;;
	esac
fi

{
	echo "created_at=$stamp"
	echo "schema_migration=$migration"
	echo "server_version=$server_version"
	echo "pg_dump_version=$(pg_dump --version)"
	echo "media=$([ "$SKIP_MEDIA" = 1 ] && echo skipped || echo included)"
	echo "leveldb=$([ -n "$WS_DATA_DIR" ] && echo included || echo skipped)"
} >"$work/backup.info"

(cd "$work" && sha256sum -- * >SHA256SUMS) || die "writing checksums failed"

mv "$work" "$final" || die "cannot rename $work to $final"
log "complete: $final ($(du -sk "$final" | cut -f1) KiB, migration $migration)"

# 4. Retention: keep the newest $RETAIN complete sets. Names sort by time.
if [ "$RETAIN" -gt 0 ]; then
	total=0
	for d in "$BACKUP_DIR"/golive-*Z; do
		[ -d "$d" ] && total=$((total + 1))
	done
	excess=$((total - RETAIN))
	if [ "$excess" -gt 0 ]; then
		for d in "$BACKUP_DIR"/golive-*Z; do
			[ "$excess" -gt 0 ] || break
			[ -d "$d" ] || continue
			log "retention: removing $d"
			rm -rf -- "$d" || die "cannot remove old backup $d"
			excess=$((excess - 1))
		done
	fi
fi
