#!/bin/sh
# Prints the production .env (read by compose.yaml and deploy.sh) from the environment.
# CD runs it with the `production` environment's secrets and variables mapped in
# (.github/workflows/cd.yml, "Write .env and SSH config"), and every deploy REPLACES the
# VM's .env with its output: a setting that isn't listed here doesn't survive a deploy.
# scripts/deploy/check-env.sh (CI) checks that these lists cover every variable
# compose.yaml reads and that cd.yml maps each of them. Runbook: docs/operations/deploy.md.
#
#   sh scripts/deploy/write-env.sh > deploy.env
#   sh scripts/deploy/write-env.sh --list required|optional
#
# Values are written single-quoted, which Compose's .env parser and sh (deploy.sh sources
# the file) both read literally: spaces, <>, # and $ in e.g. MAIL_FROM or SMTP_PASS are
# kept as they are. A value can't contain a single quote or a newline.
set -eu

# The stack doesn't start without these (compose.yaml has no default for them).
# PUBLIC_BASE_URL defaults to the site's origin below.
REQUIRED_VARS="SITE_ADDRESS POSTGRES_PASSWORD
  PASETO_V4_PUBLIC_KEY_HEX PASETO_V4_PRIVATE_KEY_HEX PASETO_V4_LOCAL_KEY_HEX
  ROLE_LOOKUP_SECRET COLLAB_INTERNAL_SECRET
  PUBLIC_BASE_URL SMTP_HOST MAIL_FROM"

# Written only when set; compose.yaml has a default for each. SITE_URL defaults to the
# site's origin below. The key rotation ones: docs/operations/key-rotation.md.
OPTIONAL_VARS="SITE_URL SMTP_PORT SMTP_TLS SMTP_USER SMTP_PASS
  CORS_ALLOWED_ORIGINS PUBLIC_API_URL
  PASETO_ACCESS_KID PASETO_REFRESH_KID
  PASETO_V4_PREVIOUS_PUBLIC_KEY_HEX PASETO_V4_PREVIOUS_LOCAL_KEY_HEX PASETO_PREVIOUS_KEYS_VALID_UNTIL"

case "${1:-}" in
  --list)
    case "${2:-}" in
      required) echo $REQUIRED_VARS ;;
      optional) echo $OPTIONAL_VARS ;;
      *) echo "usage: write-env.sh --list required|optional" >&2; exit 2 ;;
    esac
    exit 0 ;;
  "") ;;
  *) echo "usage: write-env.sh [--list required|optional]" >&2; exit 2 ;;
esac

# Email links (PUBLIC_BASE_URL) and canonical URLs (SITE_URL) default to the origin
# Caddy serves: https://<SITE_ADDRESS>, or SITE_ADDRESS itself if it has a scheme.
# GitHub passes an unset variable as "", which := also replaces.
if [ -n "${SITE_ADDRESS:-}" ]; then
  case "$SITE_ADDRESS" in
    *://*) origin="$SITE_ADDRESS" ;;
    *) origin="https://$SITE_ADDRESS" ;;
  esac
  : "${PUBLIC_BASE_URL:=$origin}"
  : "${SITE_URL:=$origin}"
fi

nl='
'
out=""
add() { # <name> <value>; never prints the value
  case "$2" in
    *"'"*|*"$nl"*)
      echo "::error::$1 contains a single quote or a newline, which the .env can't hold" >&2
      exit 1 ;;
  esac
  out="$out$1='$2'$nl"
}

missing=0
for v in $REQUIRED_VARS; do
  eval "val=\${$v:-}"
  if [ -z "$val" ]; then
    echo "::error::$v is not set in the production environment (docs/operations/deploy.md, step 3)" >&2
    missing=1
  else
    add "$v" "$val"
  fi
done
[ "$missing" = 0 ] || exit 1

for v in $OPTIONAL_VARS; do
  eval "val=\${$v:-}"
  [ -z "$val" ] || add "$v" "$val"
done

printf '%s' "$out"
