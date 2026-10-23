#!/bin/sh
# Deploys (or rolls back to) one image tag of the production compose stack on this host.
# Run from the deploy directory (compose.yaml, .env, deploy/, scripts/), normally by the
# CD workflow over SSH (.github/workflows/cd.yml). Runbook: docs/operations/deploy.md.
#
#   sh scripts/deploy/deploy.sh <image-tag>          # e.g. the 40-char commit sha
#
# Order, so the new API never runs against an unmigrated schema:
#   1. pull the three app images for <tag> (api, web, collab; websocket before #284)
#   2. refuse if the database is AHEAD of <tag>'s migrations (a rollback past a release
#      that added migrations), unless ALLOW_DOWN_MIGRATIONS=1, which migrates down with
#      the currently running API image (the only one that has those down files)
#   3. back up the database + media (scripts/backup/backup.sh), unless SKIP_BACKUP=1
#   4. run `migrate up` with the NEW api image as a one-shot container
#   5. recreate the services and wait until every healthcheck passes
#
# Env: GOLIVE_IMAGE_REGISTRY (default ghcr.io/go-live-cms), BACKUP_DIR (host path,
# default /srv/golive-backups), BACKUP_RETAIN (default 20), SKIP_PULL=1 (images already
# present), COMPOSE_PROJECT_NAME (default golive_cms, from compose.yaml).
set -eu

TAG="${1:?usage: deploy.sh <image-tag>}"
cd "$(dirname "$0")/../.."

[ -f .env ] || { echo "deploy: .env missing in $(pwd)" >&2; exit 1; }
# Values are hex/hostnames (cmd/gen-prod-env), safe to source.
set -a; . ./.env; set +a
: "${POSTGRES_PASSWORD:?deploy: POSTGRES_PASSWORD is not set in .env}"

export GOLIVE_IMAGE_REGISTRY="${GOLIVE_IMAGE_REGISTRY:-ghcr.io/go-live-cms}"
export GOLIVE_IMAGE_TAG="$TAG"
PROJECT="${COMPOSE_PROJECT_NAME:-golive_cms}"
BACKUP_DIR="${BACKUP_DIR:-/srv/golive-backups}"
DB_SOURCE="postgresql://root:${POSTGRES_PASSWORD}@postgres:5432/golive_cms?sslmode=disable"
API_IMAGE="$GOLIVE_IMAGE_REGISTRY/api:$TAG"

dc() { docker compose -p "$PROJECT" -f compose.yaml "$@"; }
log() { echo "deploy: $*"; }
psql_q() { dc exec -T postgres psql -U root -d golive_cms -tAc "$1" 2>/dev/null | tr -d '[:space:]'; }
# Highest migration number shipped in an api image (/app/migration/000012_x.up.sql -> 12).
image_migration_version() {
  docker run --rm --entrypoint sh "$1" -c 'ls /app/migration' |
    sed -n 's/^0*\([0-9][0-9]*\)_.*\.up\.sql$/\1/p' | sort -n | tail -n 1
}
migrate_with() { # <image> <migrate args...>
  image="$1"; shift
  docker run --rm --network "${PROJECT}_default" --entrypoint /app/migrate "$image" \
    -path /app/migration -database "$DB_SOURCE" "$@"
}

if [ "${SKIP_PULL:-}" != "1" ]; then
  log "pulling $GOLIVE_IMAGE_REGISTRY/{api,web,collab}:$TAG"
  dc pull --quiet api web collab postgres caddy
fi

log "starting postgres"
dc up -d --wait postgres

DB_VERSION="$(psql_q "SELECT version FROM schema_migrations" || true)"
DB_DIRTY="$(psql_q "SELECT dirty FROM schema_migrations" || true)"
TARGET_VERSION="$(image_migration_version "$API_IMAGE" || true)"
# Fail loudly instead of letting a non-number skip the rollback guard below.
case "$TARGET_VERSION" in
  ''|*[!0-9]*) echo "deploy: can't read the migration version of $API_IMAGE (image missing or no /app/migration)" >&2; exit 1 ;;
esac
case "$DB_VERSION" in
  *[!0-9]*) echo "deploy: unexpected schema_migrations version '$DB_VERSION'" >&2; exit 1 ;;
esac
log "database at migration ${DB_VERSION:-none}, $TAG ships up to $TARGET_VERSION"

if [ "$DB_DIRTY" = "t" ]; then
  echo "deploy: schema_migrations is dirty (a migration failed half way). Fix it by hand first: docs/operations/deploy.md, \"Failed migration\"." >&2
  exit 1
fi

MIGRATE_DOWN=""
if [ -n "$DB_VERSION" ] && [ "$DB_VERSION" -gt "$TARGET_VERSION" ]; then
  # Checked before the backup, so refused attempts don't rotate older backup sets out.
  if [ "${ALLOW_DOWN_MIGRATIONS:-}" != "1" ]; then
    echo "deploy: the database (migration $DB_VERSION) is ahead of $TAG (up to $TARGET_VERSION)." >&2
    echo "deploy: the older API would fail its startup 'migrate up'. Down migrations can drop data," >&2
    echo "deploy: so re-run with ALLOW_DOWN_MIGRATIONS=1 if that's intended (a backup is taken first)," >&2
    echo "deploy: or restore the pre-release backup instead. See docs/operations/deploy.md, \"Rollback\"." >&2
    exit 1
  fi
  RUNNING_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$(dc ps -q api)" 2>/dev/null || true)"
  [ -n "$RUNNING_IMAGE" ] || { echo "deploy: no running api container to migrate down with" >&2; exit 1; }
  MIGRATE_DOWN=1
fi

if [ -n "$DB_VERSION" ] && [ "${SKIP_BACKUP:-}" != "1" ]; then
  log "backing up to $BACKUP_DIR"
  mkdir -p "$BACKUP_DIR"
  docker run --rm --network "${PROJECT}_default" \
    -e DB_SOURCE="$DB_SOURCE" -e BACKUP_DIR=/backups -e MEDIA_DIR=/app/uploads/media \
    -e RETAIN="${BACKUP_RETAIN:-20}" \
    -v "${PROJECT}_uploads:/app/uploads" \
    -v "$BACKUP_DIR:/backups" \
    -v "$(pwd)/scripts/backup:/scripts:ro" \
    postgres:12-alpine sh -c 'mkdir -p "$MEDIA_DIR" && exec sh /scripts/backup.sh'
    # (The media dir only exists after the first upload, and backup.sh rightly refuses a
    # missing MEDIA_DIR, so create it; that's the volume's only write.)
fi

if [ -n "$MIGRATE_DOWN" ]; then
  log "migrating DOWN to $TARGET_VERSION with $RUNNING_IMAGE"
  # If anything below fails, bring the stopped API back rather than leave /api down.
  # (Its startup `migrate up` re-applies a completed down; a dirty schema needs a human.)
  trap 'if [ -n "${API_STOPPED:-}" ]; then echo "deploy: failed, restarting the previous api" >&2; dc start api || true; fi' EXIT
  API_STOPPED=1
  dc stop api
  migrate_with "$RUNNING_IMAGE" goto "$TARGET_VERSION"
fi

log "migrating up with $API_IMAGE"
migrate_with "$API_IMAGE" up

log "starting $TAG"
dc up -d --no-build --remove-orphans --wait --wait-timeout 240
API_STOPPED=""

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $TAG" >> .deploy-history
log "done: $TAG is live (history in .deploy-history)"
