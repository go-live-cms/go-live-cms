#!/bin/sh
# CI guard (#314): CD replaces the production .env on every deploy with the output of
# scripts/deploy/write-env.sh. A variable compose.yaml reads that the writer doesn't
# write is wiped by the next deploy, and a required one stops the stack starting (the
# first production deploy would have shipped without the mail settings). Checks:
#
#   1. every ${VAR} in compose.yaml is in write-env.sh's lists or in NOT_FROM_ENV below,
#      and every one without a default is in its required list;
#   2. cd.yml maps every listed variable into the writer's step, credentials as secrets;
#   3. `docker compose config` with a .env the writer made from dummy values (only the
#      required ones set) reports no unset variable and keeps quoted values intact.
#
#   sh scripts/deploy/check-env.sh        # from the repo root; needs docker compose
set -eu
cd "$(dirname "$0")/../.."

# Read by compose.yaml but deliberately not written to .env:
#   GOLIVE_IMAGE_REGISTRY, GOLIVE_IMAGE_TAG  exported by deploy.sh for each deploy
#   COLLAB_INTERNAL_URL                      internal wiring (collab:1236); its default is
#                                            the only right value in this stack
NOT_FROM_ENV="GOLIVE_IMAGE_REGISTRY GOLIVE_IMAGE_TAG COLLAB_INTERNAL_URL"

WRITER=scripts/deploy/write-env.sh
REQUIRED="$(sh "$WRITER" --list required)"
OPTIONAL="$(sh "$WRITER" --list optional)"
fail=0
err() { echo "::error::$*" >&2; fail=1; }
in_list() { case " $2 " in *" $1 "*) return 0 ;; esac; return 1; }

# Comments aren't interpolated by Compose.
compose_src="$(sed 's/^[[:space:]]*#.*//' compose.yaml)"
all_vars="$(printf '%s\n' "$compose_src" | grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*' | cut -c3- | sort -u)"
# ${VAR} and ${VAR:?msg}/${VAR?msg} have no default.
required_vars="$(printf '%s\n' "$compose_src" | grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*(\}|:?\?)' |
  sed -E 's/^\$\{([A-Za-z0-9_]*).*/\1/' | sort -u)"

for v in $all_vars; do
  if in_list "$v" "$NOT_FROM_ENV"; then continue; fi
  if ! in_list "$v" "$REQUIRED $OPTIONAL"; then
    err "compose.yaml reads \${$v}, but $WRITER doesn't write it: add it there and to cd.yml, or to NOT_FROM_ENV in $0 with the reason"
  fi
done
for v in $required_vars; do
  if ! in_list "$v" "$REQUIRED"; then
    err "compose.yaml requires \${$v} (no default), but it isn't in REQUIRED_VARS in $WRITER"
  fi
done

# 2. cd.yml maps each one as NAME: ${{ secrets.NAME }} or ${{ vars.NAME }}.
# Only the writer's own step counts: a mapping in another step never reaches it.
step="$(awk '/^      - name: Write \.env and SSH config$/ { on = 1; next }
             on && /^      - / { exit }
             on' .github/workflows/cd.yml)"
[ -n "$step" ] || err "cd.yml has no \"Write .env and SSH config\" step"
for v in $REQUIRED $OPTIONAL; do
  if printf '%s\n' "$step" | grep -qE "^[[:space:]]+$v: \\$\\{\\{ secrets\\.$v \\}\\}"; then
    continue
  fi
  if printf '%s\n' "$step" | grep -qE "^[[:space:]]+$v: \\$\\{\\{ vars\\.$v \\}\\}"; then
    # Variables are shown in plain text in the settings and logs.
    case "$v" in
      *PASS*|*SECRET*|*_KEY_*|*_USER) err "cd.yml passes $v from vars; credentials must be secrets" ;;
    esac
    continue
  fi
  err "$WRITER writes $v, but cd.yml's writer step doesn't map it (\"$v: \${{ secrets.$v }}\" or vars.$v)"
done

# 3. The stack's config with a CD-shaped .env. Only the required values are set, and
# SITE_ADDRESS has no scheme, so PUBLIC_BASE_URL/SITE_URL come from the writer's
# defaults. MAIL_FROM has spaces and <>, which an unquoted .env line would break on.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
hex64=0000000000000000000000000000000000000000000000000000000000000000
env -i PATH="$PATH" \
  SITE_ADDRESS=cms.example.com POSTGRES_PASSWORD=$hex64 \
  PASETO_V4_PUBLIC_KEY_HEX=$hex64 PASETO_V4_PRIVATE_KEY_HEX=$hex64$hex64 \
  PASETO_V4_LOCAL_KEY_HEX=$hex64 ROLE_LOOKUP_SECRET=$hex64 COLLAB_INTERNAL_SECRET=$hex64 \
  SMTP_HOST=smtp.example.com MAIL_FROM='GoLive CMS <no-reply@cms.example.com>' \
  SMTP_PASS='p#ss $word' \
  sh "$WRITER" > "$tmp/.env"

# Without compose.yaml's variables in the environment, so nothing outside the .env
# fills a gap. (Not env -i: docker needs its own environment to find the plugin.)
if ( for v in $all_vars; do unset "$v"; done
     docker compose -f compose.yaml --env-file "$tmp/.env" config ) > "$tmp/config.yaml" 2> "$tmp/config.err"; then
  if grep -i 'not set' "$tmp/config.err" >&2; then
    err "docker compose config: a variable compose.yaml reads is unset with the CD-shaped .env (above)"
  fi
  # Whole lines, whatever the indentation. (`config` prints a literal $ as $$.)
  sed 's/^[[:space:]]*//' "$tmp/config.yaml" > "$tmp/config.lines"
  for want in 'MAIL_FROM: GoLive CMS <no-reply@cms.example.com>' \
              'PUBLIC_BASE_URL: https://cms.example.com' \
              'SITE_URL: https://cms.example.com' \
              'SMTP_HOST: smtp.example.com' \
              'SMTP_PASS: p#ss $$word'; do
    grep -qxF "$want" "$tmp/config.lines" || err "docker compose config: expected \"$want\" in the resolved config"
  done
else
  cat "$tmp/config.err" >&2
  err "docker compose config failed with the CD-shaped .env"
fi

# A SITE_ADDRESS with a scheme is the origin as it is (no https://http://...).
origins="$(env -i PATH="$PATH" SITE_ADDRESS=http://localhost POSTGRES_PASSWORD=x \
  PASETO_V4_PUBLIC_KEY_HEX=x PASETO_V4_PRIVATE_KEY_HEX=x PASETO_V4_LOCAL_KEY_HEX=x \
  ROLE_LOOKUP_SECRET=x COLLAB_INTERNAL_SECRET=x SMTP_HOST=x MAIL_FROM=x \
  sh "$WRITER" | grep -E '^(PUBLIC_BASE_URL|SITE_URL)=')"
want_origins="PUBLIC_BASE_URL='http://localhost'
SITE_URL='http://localhost'"
[ "$origins" = "$want_origins" ] || err "$WRITER: SITE_ADDRESS=http://localhost gave: $origins"

if [ "$fail" != 0 ]; then
  echo "The production .env CD writes doesn't match compose.yaml (see the errors above; #314)." >&2
  exit 1
fi
echo "ok: CD's .env covers every variable compose.yaml reads ($(echo $all_vars | wc -w) checked)"
