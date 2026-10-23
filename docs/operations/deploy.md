# Production deployment

GoLive runs in production as the `compose.yaml` stack on a single VM. CD
(`.github/workflows/cd.yml`) builds the images, pushes them to GHCR and deploys them over
SSH (#267). Backups and restores: [backups.md](backups.md).

## The stack

```
browser ──https──▶ caddy :443 ──/collab/*──▶ websocket:1234 ──▶ api:8081 (internal role lookup)
  (80 → 443)         │                          LevelDB volume ws_data
                     └──everything else──▶ web:4321 (Astro SSR + admin SPA)
                                              │ /api/v1, /uploads forwarded (apiProxy.ts)
                                              │ SSR fetches: SERVER_API_URL
                                              ▼
                                           api:8080 ──▶ postgres:5432
```

| Service | Image | Published | State |
|---------|-------|-----------|-------|
| `caddy` | `caddy:2.10-alpine` | 80, 443 (tcp+udp) | `caddy_data` (certificates; keep it) |
| `web` | `ghcr.io/go-live-cms/web` | no | none |
| `websocket` | `ghcr.io/go-live-cms/websocket` | no | `ws_data` (LevelDB) |
| `api` | `ghcr.io/go-live-cms/api` | no | `uploads` |
| `postgres` | `postgres:12-alpine` | no | `postgres_data` |

- **Caddy** terminates TLS (Let's Encrypt for a domain, its local CA for `localhost`) and
  is the only thing on the internet. It sends `/collab/*` to the collab server, because the
  Astro server can't proxy a WebSocket upgrade, and everything else to `web`. Its access log
  is off: the collab URL carries a single-use ticket. Config: `deploy/caddy/Caddyfile`.
- **Exactly one `websocket` process.** Live Yjs docs and the ticket replay guard live in its
  memory (`websocket/CLAUDE.md`). Never scale it.
- **Client IPs.** Browser API calls go caddy → web → api. The API trusts exactly those two
  fixed addresses (`172.28.0.11` caddy, `172.28.0.10` web, `TRUSTED_PROXIES`), and Caddy
  drops any `X-Forwarded-For` a client sends. If a cloud load balancer sits in front of
  Caddy, add its range as Caddy `trusted_proxies` (see the Caddyfile comment).
- `web` and `websocket` run as the `node` user. The `api` image still runs as root.

### API URLs: server side vs browser

| Variable (web) | Read | Value in compose.yaml | Used by |
|---|---|---|---|
| `SERVER_API_URL` | at **runtime** (`process.env`) | `http://api:8080/api/v1` | every SSR fetch: `gl-admin/lib/server-api-url.ts` and everything that imports it (`src/lib/api.ts`, `theme-api-client.ts`, `theme-settings.ts`, `Blog/Post.astro`, `/api/posts-reload`), and the `/api/v1` + `/uploads` forwarder |
| `PUBLIC_API_URL` | at runtime by the middleware | unset | the browser-facing API origin, only for the admin CSP (`connect-src`/`img-src`). Leave it unset: the browser calls `/api/v1` and `/uploads` same-origin. Set it only if media is served from another origin. |
| `SITE_URL` | at **runtime** (`process.env`) | `https://$SITE_ADDRESS` unless `SITE_URL` is set | the public origin in canonical/`og:url` tags, `/robots.txt` and `/sitemap.xml` (`src/lib/seo.ts`, #137). Set it yourself if `SITE_ADDRESS` carries a scheme or port. Empty, it falls back to the request's Host header, and robots/sitemap are sent `private, no-store` so a spoofed host can't be cached. |

No server-side code reads `PUBLIC_API_URL` any more, and nothing API-related is baked in at
build time, so one web image works for any domain.

### Themes are build-time

Decision (#272): themes are part of the build, not loaded at runtime.

- Vite resolves the middleware's theme globs (`themes/*/theme.config.ts`,
  `functions.ts`) and the theme `.astro` layouts (`import.meta.glob`) when the web image
  is built. A theme copied into a running container can't load: the server logs
  `Theme "<slug>" is not in this build` and falls back to the theme's CSS only. Don't
  mount a volume over `/app/themes`.
- The API registers themes by scanning `web/themes` on startup, so the API image ships
  that directory too (`Dockerfile`, `.dockerignore`).
- Switching between the bundled themes works at runtime (admin → Themes), and their
  assets are served from `/themes/<slug>/…` for the allowlisted types only (css, js,
  images, fonts; #271). Theme source (`.ts`, `.astro`) returns 404.
- **To add or change a theme**, commit it under `web/themes/` and deploy. Build the api
  and web images from the same commit (CD does).

## First-time VM setup

Any Linux VM with Docker Engine + the Compose plugin (v2.20+, for `up --wait`), ports
80/443 open, and DNS for your domain pointing at it. 2 GB RAM is enough for a small site.

1. **Deploy user.** Create a user in the `docker` group and give it the deploy directory:
   ```sh
   sudo useradd -m -G docker deploy
   sudo mkdir -p /opt/golive /srv/golive-backups && sudo chown deploy: /opt/golive /srv/golive-backups
   ```
   Generate an SSH key pair for CD (`ssh-keygen -t ed25519 -f golive-deploy -N ''`) and
   add the public half to `~deploy/.ssh/authorized_keys`.
2. **Secrets.** On your machine, from the repo root:
   ```sh
   go run ./cmd/gen-prod-env -site cms.example.com > prod.env
   ```
   It prints fresh PASETO keys and random hex secrets. Never reuse `example.app.env`'s keys.
3. **GitHub.** Settings → Environments → `production`: add required reviewers, then:

   | Kind | Name | Value |
   |------|------|-------|
   | variable | `SITE_ADDRESS` | your domain, e.g. `cms.example.com` |
   | variable | `DEPLOY_PATH` | `/opt/golive` (default) |
   | secret | `POSTGRES_PASSWORD`, `PASETO_V4_PUBLIC_KEY_HEX`, `PASETO_V4_PRIVATE_KEY_HEX`, `PASETO_V4_LOCAL_KEY_HEX`, `ROLE_LOOKUP_SECRET`, `COLLAB_INTERNAL_SECRET` (formerly `COLLAB_SQUASH_SECRET`, which CD still falls back to) | from `prod.env` |
   | secret | `DEPLOY_HOST`, `DEPLOY_USER` | the VM's address, `deploy` |
   | secret | `DEPLOY_SSH_KEY` | the private key from step 1 |
   | secret | `DEPLOY_KNOWN_HOSTS` | `ssh-keyscan -t ed25519 <host>`, checked against the VM's real fingerprint |

   Then set the **repository** variable `DEPLOY_ENABLED=true`. Until it is set, CD only
   pushes images. Delete `prod.env` afterwards; GitHub is now the source of truth, and
   every deploy rewrites `/opt/golive/.env` (mode 600) from it.
4. **First deploy.** Merge to `main` (or run the `cd` workflow manually with a sha CD
   already pushed). The first run creates the database and the volumes.
5. **First admin account.** Release mode never seeds accounts, and registration isn't
   implemented, so create the first admin in the database:
   ```sh
   cd /opt/golive
   docker compose exec postgres psql -U root -d golive_cms
   ```
   ```sql
   CREATE EXTENSION IF NOT EXISTS pgcrypto;
   INSERT INTO users (username, full_name, email, hashed_password, role, password_changed_at)
   VALUES ('<username>', '<Full Name>', '<email>', crypt('<a strong password>', gen_salt('bf', 10)), 'admin', now());
   ```
   Log in at `https://<domain>/login`, then add other users from the admin. Don't use the
   seeded names (`admin`, `editor`, …) with their dev passwords: the API refuses to start
   while one exists (readme, "Seeded dev accounts in production").
6. **Backups.** Schedule `scripts/backup/backup.sh` (already copied to
   `/opt/golive/scripts/backup`) as described in [backups.md](backups.md). The deploy
   script also takes a backup before every deploy.

## What a deploy does

CD runs `scripts/deploy/deploy.sh <sha>` on the VM after copying `compose.yaml`, the
Caddyfile, the scripts and `.env` to `DEPLOY_PATH`:

1. `docker compose pull` the three images for `<sha>` (GHCR login with the job's
   short-lived token, logged out afterwards).
2. Check the schema version. A dirty `schema_migrations` stops the deploy. So does a
   database newer than `<sha>`'s migrations (see Rollback). Both stop before the backup,
   so refused attempts don't rotate older backup sets out.
3. Back up the database and media to `BACKUP_DIR` (`/srv/golive-backups`, keeps 20 sets).
4. **Migrations run before the new API starts:** a one-shot `migrate up` with the new api
   image. The old API keeps serving meanwhile, so a migration must stay compatible with the
   previous release (add columns/tables first, drop them a release later). `start.sh` still
   runs `migrate up` on boot, which is then a no-op.
5. `docker compose up -d --wait`: recreates what changed and fails the job unless every
   healthcheck passes (api `/readyz`, web `/favicon.ico`, websocket `/`) within 4 minutes.
6. Appends `<time> <sha>` to `/opt/golive/.deploy-history`.

Deploys run one at a time. An automatic deploy is skipped when its commit is no longer
`main`'s tip by the time it runs, so a slow older run can't roll back a newer one.

Expect a few seconds of downtime while containers are recreated. Open editors show
"Reconnecting" and resync by themselves: LevelDB and the editor's 2s autosave cover the gap.

## Rollback

Find the previous sha in `/opt/golive/.deploy-history` (or the Actions history), then run
the **cd** workflow manually (Actions → cd → Run workflow) with that sha.

- **No new migrations since that release:** that's it.
- **The bad release added migrations:** the old API image doesn't have them, so its
  startup `migrate up` would fail. The deploy stops and says so. Choose one:
  - Tick **allow_down_migrations**. The script takes a backup, then migrates down to the
    old release's version with the *current* api image (the only one with those down
    files). If that fails, it starts the previous API again before exiting. Down migrations can drop data (e.g. `000004` drops `block_doc`), so read them
    first.
  - Or restore the backup taken just before the bad deploy ([backups.md](backups.md),
    "Restoring"), then deploy the old sha.

On the VM directly, the equivalent is:
```sh
cd /opt/golive && sh scripts/deploy/deploy.sh <sha>                           # or
cd /opt/golive && ALLOW_DOWN_MIGRATIONS=1 sh scripts/deploy/deploy.sh <sha>
```

### Failed migration

golang-migrate marks the version dirty, and the deploy stops before it recreates any
service, so the old release keeps running. Recover as in [backups.md](backups.md), "A
failed migration (`dirty=true`)", or restore the pre-deploy backup, then deploy again.

## Running the production stack locally

```sh
go run ./cmd/gen-prod-env -site localhost > .env       # .env is gitignored
docker compose -f compose.yaml up --build -d
```

Open `https://localhost` and accept the warning for Caddy's local certificate. Create the
first admin as in step 5. To skip TLS locally, set `SITE_ADDRESS=http://localhost`:
browsers accept the `Secure` refresh cookie on `localhost`, and the editor then uses
`ws://localhost/collab`.

## Upgrading from before #272

The old `compose.yaml` had no proxy or collab server, a fixed Postgres password `secret`,
and published 5432, 8080 and 4321.

1. Back up first ([backups.md](backups.md)). Then stop the old stack with
   `docker compose down` (**without** `-v`: the volumes hold your data). The default
   network's address config changed (a fixed `ip_range`), and Compose won't change an
   existing network in place; `down` removes it, and the first deploy recreates it.
2. Postgres only reads `POSTGRES_PASSWORD` when it initialises an empty volume. With
   existing data, either set `POSTGRES_PASSWORD=secret` in `.env` for the first start,
   or change the password before switching:
   `docker compose exec postgres psql -U root -c "ALTER USER root PASSWORD '<new hex password>'"`.
3. The site moves from `:4321` to `https://<domain>` (443). Point DNS and any monitoring
   there. The API and Postgres are no longer reachable from the host; use
   `docker compose exec`.
