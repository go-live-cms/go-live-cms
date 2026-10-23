#!/bin/sh
# Runs leveldb-diff.mjs against a dev compose project's ws_data volume (#206 P4, #284),
# in a throwaway container: the host's web/ and websocket/ node_modules are incomplete on
# Windows. Read-only: the volume is mounted :ro, and the block docs are read with SELECT.
# Run from anywhere with Docker (Git Bash, WSL, Linux), BEFORE switching the dev stack:
#
#   sh scripts/collab/leveldb-diff-dev.sh                # project golive_cms_dev
#   sh scripts/collab/leveldb-diff-dev.sh <project>      # e.g. an isolated -p stack
#
# Needs: the project's postgres running, and its web and websocket images built from this
# checkout's lockfiles (checked; `docker compose -f compose.dev.yaml --profile y-websocket
# build web websocket` otherwise). The report
# is also written to scripts/collab/leveldb-diff-<project>.json (gitignored).
# Overrides: WS_DATA_VOLUME=<volume> (default <project>_ws_data, e.g. a copy) and
# BLOCK_DOCS=<file> (an export made elsewhere, see leveldb-diff.mjs; skips postgres).
# Runbook: docs/operations/collab-cutover.md.
set -eu
# Git Bash would rewrite the container paths below into Windows paths.
export MSYS_NO_PATHCONV=1

PROJECT=${1:-golive_cms_dev}
cd "$(dirname "$0")/../.."
REPO=$(pwd)
VOLUME="${WS_DATA_VOLUME:-${PROJECT}_ws_data}"
RUNNER="${PROJECT}-leveldb-diff"
WS_TMP="${PROJECT}-leveldb-diff-ws"
OUT="scripts/collab/leveldb-diff-${PROJECT}.json"

NM_TAR=$(mktemp)
cleanup() { docker rm -f -v "$RUNNER" "$WS_TMP" >/dev/null 2>&1 || true; rm -f "$REPO/scripts/collab/.blockdocs.json" "$NM_TAR"; }
trap cleanup EXIT
cleanup

docker volume inspect "$VOLUME" >/dev/null 2>&1 || { echo "leveldb-diff: no volume $VOLUME: nothing to compare" >&2; exit 0; }

# The runner pairs this checkout's source with the images' node_modules. An image built
# from another lockfile would convert with other TipTap/yjs versions than the source
# expects (or miss a module), so refuse and say which image to rebuild. CRs are stripped:
# a Windows checkout may have CRLF where the image doesn't.
lock_hash() { tr -d '\r' | sha256sum | cut -d' ' -f1; }
for app in web websocket; do
  image_lock=$(docker run --rm --entrypoint cat "${PROJECT}-${app}" /app/package-lock.json | lock_hash)
  local_lock=$(lock_hash < "$app/package-lock.json")
  if [ "$image_lock" != "$local_lock" ]; then
    echo "leveldb-diff: image ${PROJECT}-${app} was built from a different $app/package-lock.json than this checkout." >&2
    echo "leveldb-diff: rebuild it (the running container is unaffected): docker compose -p $PROJECT -f compose.dev.yaml --profile y-websocket build $app" >&2
    exit 2
  fi
done

if [ -n "${BLOCK_DOCS:-}" ]; then
  cp "$BLOCK_DOCS" scripts/collab/.blockdocs.json
else
  echo "==> exporting block_doc from ${PROJECT}'s postgres (SELECT only)"
  docker compose -p "$PROJECT" -f compose.dev.yaml exec -T postgres psql -U root -d golive_cms -Atc \
    "select coalesce(json_object_agg(id, json_build_object('block_doc', block_doc, 'block_revision', block_revision, 'changed_at', changed_at)), '{}') from posts" \
    > scripts/collab/.blockdocs.json
fi

echo "==> preparing the runner (${PROJECT}-web image + websocket's node_modules)"
# /work and /ws are anonymous volumes so `docker cp` has directories to copy into.
docker create --name "$RUNNER" -w /work -v /work -v /ws -v "$VOLUME:/ldb:ro" --entrypoint node "${PROJECT}-web" \
  /work/scripts/collab/leveldb-diff.mjs --data /ldb --block-docs /work/blockdocs.json \
  --web /app --websocket /ws --json /work/report.json >/dev/null
docker create --name "$WS_TMP" "${PROJECT}-websocket" >/dev/null
# Through a file, not a pipe: `sh` has no pipefail, and a failed export would be masked.
docker cp "$WS_TMP:/app/node_modules" - > "$NM_TAR"
docker cp - "$RUNNER:/ws/" < "$NM_TAR"
docker cp websocket/package.json "$RUNNER:/ws/package.json"
# The web image has node_modules but no source (dev bind-mounts it).
tar -c -C web package.json tsconfig.json collab-server gl-admin | docker cp - "$RUNNER:/app"
tar -c scripts/collab/leveldb-diff.mjs scripts/collab/leveldb-export.cjs | docker cp - "$RUNNER:/work"
docker cp scripts/collab/.blockdocs.json "$RUNNER:/work/blockdocs.json"

echo "==> comparing (LevelDB copy in the container's tmp)"
status=0
docker start -a "$RUNNER" || status=$?
docker cp "$RUNNER:/work/report.json" "$OUT" 2>/dev/null && echo "report: $OUT"
exit $status
