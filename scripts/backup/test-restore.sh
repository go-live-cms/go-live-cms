#!/bin/sh
# End-to-end test of backup.sh / restore.sh on a throwaway compose project
# (golive_restore_test, see compose.restore-test.yaml). Never touches the dev
# stack. Run from anywhere with Docker available (Linux, WSL, Git Bash, CI):
#
#   sh scripts/backup/test-restore.sh          # KEEP=1 leaves the stack up
#
# What it proves:
#   1. migrations go up, all the way down, and up again on an empty database;
#   2. backup.sh writes complete, checksummed sets, enforces retention, and
#      fails (non-zero, no leftover set) on a bad config or unreachable DB;
#   3. restore.sh refuses to overwrite a non-empty database without --force;
#   4. after wiping the database and media, restore.sh brings back identical
#      row counts, an identical post block_doc, the collab server's stored Yjs
#      state (post_ydoc_state) and the same schema version;
#   5. --force replaces existing data; a least-privilege user can restore; a
#      --force restore that fails midway rolls back to the old data;
#   6. the real API (release mode, so the seeded-account guard runs) starts on
#      the restored data and serves the restored media file byte for byte.

set -eu
# Git Bash would rewrite the container paths below into Windows paths.
export MSYS_NO_PATHCONV=1

KEEP=${KEEP:-0}
# Relative compose path: with path conversion off, Git Bash's /c/... would break it.
cd "$(dirname "$0")"

compose() { docker compose -f compose.restore-test.yaml --profile tools --profile api "$@"; }
step() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nFAIL: %s\n' "$*" >&2; exit 1; }
psql_q() { compose exec -T postgres psql -U root -d golive_cms -X -A -t -v ON_ERROR_STOP=1 -c "$1"; }
in_tools() { compose run --rm -T tools -c "$1"; }
# expect_fail <what> <message the script must print> <tools command>: the command
# must fail AND say why, so a crash or a docker error can't pass as a refusal.
expect_fail() {
	if out=$(in_tools "$3" 2>&1); then fail "$1 succeeded"; fi
	printf '%s\n' "$out" | grep -q -- "$2" || fail "$1 failed without '$2':
$out"
}

teardown() {
	status=$?
	if [ "$status" -ne 0 ]; then
		echo "--- api logs (tail) ---" >&2
		compose logs --tail 40 api >&2 2>/dev/null || true
	fi
	if [ "$KEEP" = 1 ]; then
		echo "KEEP=1: leaving the golive_restore_test stack up" >&2
	else
		compose down -v --remove-orphans >/dev/null 2>&1 || true
	fi
	exit "$status"
}
trap teardown EXIT

# Row count of every table in public, one "table|count" line each.
row_counts() {
	psql_q "SELECT table_name || '|' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', table_name), false, true, '')))[1]::text
	        FROM information_schema.tables
	        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
	        ORDER BY table_name"
}
fingerprint() {
	row_counts
	psql_q "SELECT 'posts.block_doc md5|' || md5(string_agg(id || ':' || block_doc::text, ',' ORDER BY id)) FROM posts"
	psql_q "SELECT 'post_ydoc_state|' || coalesce(string_agg(encode(state, 'hex') || ' ' || epoch || ' r' || block_revision, ',' ORDER BY post_id), '') FROM post_ydoc_state"
	psql_q "SELECT 'schema_migrations|' || version || ' dirty=' || dirty FROM schema_migrations"
}
media_sha() { in_tools 'sha256sum /app/uploads/media/restore-test.bin' | cut -d' ' -f1; }

step "fresh scratch stack"
compose down -v --remove-orphans >/dev/null 2>&1 || true
# Go caches are external so `down -v` keeps them between runs.
docker volume create golive_restore_test_gomod >/dev/null
docker volume create golive_restore_test_gocache >/dev/null
compose up -d --wait postgres

step "migrations: up, down -all, up"
compose run --rm -T migrate up
compose run --rm -T migrate down -all
[ "$(psql_q "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'")" = 0 ] ||
	fail "tables left behind after migrate down -all"
compose run --rm -T migrate up

step "fixture data: 1 user, 250 posts with block_doc, a stored Yjs state, 1 media row + file"
compose exec -T postgres psql -U root -d golive_cms -X -q -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO users (username, full_name, email, hashed_password, role)
VALUES ('restore-tester', 'Restore Tester', 'restore@example.test', '$2a$10$not.a.real.hash', 'admin');

INSERT INTO posts (title, description, user_id, username, url, slug, post_status, block_doc)
SELECT 'Post ' || g, 'fixture', u.id, u.username, '/posts/restore-' || g, 'restore-' || g, 'published',
       jsonb_build_object(
         'doc_version', 1,
         'blocks_order', jsonb_build_array('b' || g),
         'blocks', jsonb_build_object('b' || g, jsonb_build_object(
           'id', 'b' || g, 'type', 'paragraph',
           'content', 'Body of post ' || g || ' ' || chr(252) || chr(10003))))
FROM generate_series(1, 250) AS g, users u
WHERE u.username = 'restore-tester';

INSERT INTO media (name, description, alt, media_path, user_id, mime_type, original_filename)
SELECT 'restore-test', 'fixture', 'fixture', '/app/uploads/media/restore-test.bin', id,
       'application/octet-stream', 'restore-test.bin'
FROM users WHERE username = 'restore-tester';

INSERT INTO post_media (post_id, media_id)
SELECT (SELECT id FROM posts WHERE slug = 'restore-42'), (SELECT id FROM media WHERE name = 'restore-test');

-- The collab server's live Yjs state lives in Postgres since #206, so the dump
-- must carry it (bytes and the revision guard's block_revision).
INSERT INTO post_ydoc_state (post_id, state, epoch, block_revision)
SELECT id, decode('0102030405ff00', 'hex'), '6f1c1a52-6a0e-4c0f-9c1e-2b7a5d9f0a11', block_revision
FROM posts WHERE slug = 'restore-42';
SQL
in_tools 'mkdir -p /app/uploads/media && head -c 65536 /dev/urandom > /app/uploads/media/restore-test.bin'

expected=$(fingerprint)
expected_post=$(psql_q "SELECT block_doc::text FROM posts WHERE slug = 'restore-42'")
expected_sha=$(media_sha)
media_id=$(psql_q "SELECT id FROM media WHERE name = 'restore-test'")
post_id=$(psql_q "SELECT id FROM posts WHERE slug = 'restore-42'")
echo "$expected"

step "backup: three runs with RETAIN=2 keep the newest two"
for i in 1 2 3; do
	in_tools 'RETAIN=2 sh /scripts/backup.sh'
	sleep 1
done
sets=$(in_tools 'ls -d /backups/golive-*Z | wc -l' | tr -d ' \r')
[ "$sets" = 2 ] || fail "expected 2 backup sets after retention, found $sets"
in_tools 'ls -l /backups/$(ls /backups | tail -n 1) && cat /backups/$(ls /backups | tail -n 1)/backup.info'

step "backup: failures exit non-zero and leave no set behind"
expect_fail "backup without MEDIA_DIR" "MEDIA_DIR is not set" 'MEDIA_DIR= sh /scripts/backup.sh'
expect_fail "backup with a bad password" "pg_dump failed" \
	'DB_SOURCE=postgresql://root:wrong@postgres:5432/golive_cms?sslmode=disable sh /scripts/backup.sh'
leftover=$(in_tools 'ls -d /backups/*.partial 2>/dev/null | wc -l' | tr -d ' \r')
[ "$leftover" = 0 ] || fail "a failed backup left $leftover .partial set(s)"
sets=$(in_tools 'ls -d /backups/golive-*Z | wc -l' | tr -d ' \r')
[ "$sets" = 2 ] || fail "failed backups changed the set count to $sets"

latest='/backups/$(ls /backups | tail -n 1)'

step "restore: refuses a non-empty database without --force"
expect_fail "restore into a non-empty database" "refusing to overwrite existing data" "sh /scripts/restore.sh $latest"
[ "$(psql_q 'SELECT count(*) FROM posts')" = 250 ] || fail "the refused restore changed the database"

step "restore: refuses a damaged set"
in_tools "cp -R $latest /backups/damaged && printf x >> /backups/damaged/db.dump"
expect_fail "restore of a damaged set" "checksum mismatch" 'sh /scripts/restore.sh /backups/damaged'
in_tools 'rm -rf /backups/damaged'

step "wipe: drop the database, delete media"
compose exec -T postgres dropdb -U root golive_cms
compose exec -T postgres createdb -U root golive_cms
in_tools 'rm -rf /app/uploads/media && ls -A /app/uploads'
[ "$(psql_q "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")" = 0 ] || fail "wipe left tables"

step "restore into the fresh database and empty media dir"
in_tools "sh /scripts/restore.sh $latest"

step "verify: row counts, block_doc, schema version, media file"
actual=$(fingerprint)
[ "$actual" = "$expected" ] || fail "restored data differs:
--- expected
$expected
--- actual
$actual"
[ "$(psql_q "SELECT block_doc::text FROM posts WHERE slug = 'restore-42'")" = "$expected_post" ] ||
	fail "post restore-42 block_doc differs"
[ "$(media_sha)" = "$expected_sha" ] || fail "restored media file differs"
echo "identical: $(echo "$actual" | wc -l | tr -d ' ') fingerprint lines, post block_doc, media sha256 $expected_sha"

step "restore as a least-privilege user (owns its database, not schema public)"
psql_q "CREATE ROLE restorer LOGIN PASSWORD 'restorer'" >/dev/null
compose exec -T postgres createdb -U root -O restorer golive_np
in_tools "DB_SOURCE='postgresql://restorer:restorer@postgres:5432/golive_np?sslmode=disable' SKIP_MEDIA=1 sh /scripts/restore.sh $latest"
[ "$(compose exec -T postgres psql -U root -d golive_np -X -A -t -c 'SELECT count(*) FROM posts' | tr -d '\r')" = 250 ] ||
	fail "least-privilege restore is incomplete"

step "restore --force that fails rolls back to the old data"
# An event trigger (its function outside schema public, so DROP SCHEMA public
# CASCADE keeps it) fails the first CREATE TABLE, i.e. after the DROP SCHEMA
# already ran in the restore transaction.
psql_q "CREATE SCHEMA blocker;
	CREATE FUNCTION blocker.fail() RETURNS event_trigger LANGUAGE plpgsql AS \$\$ BEGIN RAISE EXCEPTION 'blocked by test-restore'; END \$\$;
	CREATE EVENT TRIGGER block_create_table ON ddl_command_start WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION blocker.fail();" >/dev/null
expect_fail "restore --force that fails midway" "rolled back" "sh /scripts/restore.sh --force $latest"
psql_q "DROP EVENT TRIGGER block_create_table; DROP SCHEMA blocker CASCADE;" >/dev/null
[ "$(fingerprint)" = "$expected" ] || fail "a failed --force restore changed the database"
[ "$(media_sha)" = "$expected_sha" ] || fail "a failed --force restore touched the media"

step "restore --force over the restored data"
in_tools "sh /scripts/restore.sh --force $latest"
[ "$(fingerprint)" = "$expected" ] || fail "--force restore differs"

step "API (release mode) starts on the restored data and serves the media"
compose up -d --wait api
served=$(compose exec -T api sh -c 'wget -qO- http://127.0.0.1:8080/uploads/media/restore-test.bin | sha256sum' | cut -d' ' -f1)
[ "$served" = "$expected_sha" ] || fail "API served media sha256 $served, expected $expected_sha"
# The row stores the filesystem path; the API returns the URL it serves it at.
compose exec -T api wget -qO- "http://127.0.0.1:8080/api/v1/media/$media_id" | grep -q '"media_path":"/uploads/media/restore-test.bin"' ||
	fail "GET /api/v1/media/$media_id does not return the restored row"
compose exec -T api wget -qO- "http://127.0.0.1:8080/api/v1/posts/$post_id" | grep -q '"Post 42"' ||
	fail "GET /api/v1/posts/$post_id does not return the restored post"

printf '\nPASS: backup -> wipe -> restore -> verify\n'
