#!/bin/sh
# Restore a GoLive CMS backup set made by backup.sh.
#
#   restore.sh [--force] <backup-set-dir>
#
# Restores into a FRESH database and an EMPTY media directory. Before touching
# anything it verifies the set's checksums and checks every target; if the
# database has any tables, or MEDIA_DIR has any files, it refuses and changes
# nothing. --force replaces them instead: it DROPS the public schema and empties
# the directory first. Prefer restoring into a new database.
#
# Configuration (environment only):
#   DB_SOURCE     postgres URL of the TARGET database (or the libpq PG* variables).
#                 The database must exist (createdb); restore.sh creates its contents.
#   MEDIA_DIR     target for the media archive; must match the API's UPLOAD_PATH
#                 (media rows store absolute paths under it). Required unless the
#                 set has no media or SKIP_MEDIA=1.
#
# Stop the API and collab server before restoring into the live targets (the
# collab server holds open documents in memory and would store them back).
# See docs/operations/backups.md.

set -eu

FORCE=0
SET_DIR=
SKIP_MEDIA=${SKIP_MEDIA:-0}
MEDIA_DIR=${MEDIA_DIR:-}

log() { printf '%s restore: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
usage() { echo "usage: $0 [--force] <backup-set-dir>" >&2; exit 2; }

while [ $# -gt 0 ]; do
	case $1 in
		--force) FORCE=1 ;;
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
if [ -n "$refuse" ]; then
	if [ "$FORCE" != 1 ]; then
		die "refusing to overwrite existing data:$refuse
Restore into a new database / empty directories, or pass --force to DELETE it first."
	fi
	log "--force: replacing existing data:$refuse"
fi

# --- 3. Database --------------------------------------------------------------
# Render the dump to SQL first, then run the --force schema reset AND the
# restore in one psql transaction: on any error the database is left exactly
# as it was, old data included. Ownership/grants are not restored, so objects
# belong to the DB_SOURCE user. The public schema's own entries are skipped:
# only its owner (the bootstrap superuser on PG 12) may comment on it, which
# would abort a restore by a least-privilege user.
sql_file=$(mktemp "${TMPDIR:-/tmp}/golive-restore.XXXXXX") || die "cannot create a temp file"
toc_file="$sql_file.toc"
trap 'rm -f -- "$sql_file" "$toc_file"' EXIT
pg_restore --list "$SET_DIR/db.dump" | grep -v -E '^[0-9]+; [0-9]+ [0-9]+ (SCHEMA - public|COMMENT - SCHEMA public) ' >"$toc_file" ||
	die "cannot read the dump's table of contents"
{
	if [ "$tables" -ne 0 ]; then
		echo "DROP SCHEMA public CASCADE;"
		echo "CREATE SCHEMA public;"
	fi
	pg_restore --no-owner --no-privileges --use-list="$toc_file" --file=- "$SET_DIR/db.dump" ||
		die "cannot render db.dump to SQL (nothing was changed)"
} >"$sql_file" || die "cannot render db.dump to SQL (nothing was changed)"
[ "$tables" -eq 0 ] || log "--force: dropping and recreating schema public in the restore transaction"
log "restoring database"
pg psql -X -q -v ON_ERROR_STOP=1 --single-transaction -f "$sql_file" >/dev/null ||
	die "restore failed and was rolled back; the target database is unchanged"

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

log "done. Start the API (it runs pending migrations) and check the runbook's verification steps."
