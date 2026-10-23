# GoLive CMS - Development Guide

A full-stack CMS built with Go (Gin), PostgreSQL, and Astro.

## 🚀 Quick Start

```bash
git clone <repo>
cd go-live-cms
./scripts/gen-ws-env.sh          # ⚠️  REQUIRED: Generates auth keys
make devbuild
```

### Prerequisites

- Docker & Docker Compose
- Go 1.19+
- Node.js 18+
- WSL (for Windows users)

### Development Setup

1. **Clone and setup the project:**

   ```bash
   git clone <repository-url>
   cd go-live-cms
   ```

2. **Important**
   Make sure the startdev.sh, wait-for.sh and start.sh are in the LF format instead of CRLF

3. **Environment configuration:**

   ```bash
   cp example.app.env app.env
   # Edit app.env with your configuration if needed
   ```

4. **Start development environment:**

   ```bash
   make dev
   ```

   This will start:

   - PostgreSQL database on port 5432
   - Go API server on http://localhost:8080
   - Astro frontend on http://localhost:4321

5. **Check logs (optional):**
   ```bash
   make devlogs        # All services
   make devlogs-api    # API only
   make devlogs-web    # Frontend only
   ```

## 🛠️ Development Commands

### Docker Development

```bash
make dev           # Start development environment
make devdown       # Stop development environment
make devrebuild    # Rebuild and restart all services
make devlogs       # View all logs
make devlogs-api   # View API logs only
make devlogs-web   # View frontend logs only
```

### Seed data

In debug mode (`GIN_MODE=debug`, which `compose.dev.yaml` sets) the API seeds a
fresh database on startup: an admin account, the dummy users `editor`, `author`,
`contributor` and `moderator` (password `password123`), categories, tags, 12 media
items, 10 posts and 5 pages. To run the same seed explicitly, for example after
emptying the database or against a database the API doesn't start on:

```bash
make devseed       # in the running dev stack's api container
make seed          # with Go installed locally, against DB_SOURCE in app.env
```

Both run `go run ./cmd/seed`. Notes:

- **Safe to rerun.** The admin is skipped if it exists, and the dummy content is
  skipped if the database has more than one user. The command also writes back
  sample image files that a media row still references but that are missing from
  `UPLOAD_PATH`, so rerunning it fixes broken images in a database seeded by an
  older version. It never overwrites a file and never recreates one whose media
  was deleted. Startup seeding doesn't restore files.
- **Admin credentials** default to `admin` / `123456`. Set `SEED_ADMIN_USER` and
  `SEED_ADMIN_PASS` (in `app.env` or the environment) to use others.
- **Dev only.** It refuses to run unless `GIN_MODE=debug`. `make seed ARGS=-force`
  overrides that, but a release-mode API then refuses to start until the seeded
  passwords are changed (see "Seeded dev accounts in production" below).
- **Media files** are the 12 images in `devModeUtil/sampleimages/` (generated, CC0,
  about 170 KB in all; see the README there). They are embedded in the binary and
  copied into `UPLOAD_PATH` like uploads, so seeding works offline.

### Production

```bash
make prod          # Start production environment
make proddown      # Stop production environment
make prodlogs      # View production logs
```

`compose.yaml` is the production stack: Caddy (TLS, the only published service, routes
`/collab` to the collab server and everything else to web), web, the collab WebSocket
server, the API and Postgres. CD deploys it to a single VM from GHCR images. Setup,
secrets, the first admin account, deploys, rollback and the build-time theme rule:
**[docs/operations/deploy.md](docs/operations/deploy.md)**.

The images contain no `app.env`. `compose.yaml` takes its secrets from a `.env` file next
to it (never committed). Generate one with fresh keys, never `example.app.env`'s:

```bash
go run ./cmd/gen-prod-env -site cms.example.com > .env
```

#### Seeded dev accounts in production

Versions before #228 always ran the API in debug mode, so every deployment got the
dev accounts: `admin` / `123456` (admin role) and `editor`, `author`, `contributor`,
`moderator` / `password123`. Those passwords are public. Outside debug mode the API
now **refuses to start** while any of them still has its seeded password, and logs:

```
❌ Cannot set up server: refusing to start: account(s) admin, editor still have the publicly known password ...
```

It also refuses to start if it cannot run that check (for example, the database is
unreachable).

To recover, set new passwords directly in the database. You don't need to log in, and
debug mode isn't involved. With the production compose stack:

```bash
docker compose exec postgres psql -U root -d golive_cms
```

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Give admin a new password (bcrypt, which the API verifies). Setting
-- password_changed_at revokes its access tokens; blocking sessions revokes refresh tokens.
UPDATE users
   SET hashed_password = crypt('<a new strong password>', gen_salt('bf', 10)),
       password_changed_at = now()
 WHERE username = 'admin';

-- Lock the dummy accounts the error named with random passwords nobody knows
-- (or delete them if they own nothing you need). Trim the list to those names.
UPDATE users
   SET hashed_password = crypt(encode(gen_random_bytes(32), 'hex'), gen_salt('bf', 10)),
       password_changed_at = now()
 WHERE username IN ('editor', 'author', 'contributor', 'moderator');

UPDATE sessions SET is_blocked = true
 WHERE username IN ('admin', 'editor', 'author', 'contributor', 'moderator');
```

Then start the API again. If an account was used while it had the known password,
review what it changed.

#### Email: invitations and password reset

The alpha is invite-only: admins invite people from **Users → Invite user**, and
anyone can reset a forgotten password from the sign-in page. Both send an email,
so outside `GIN_MODE=debug` the API **refuses to start** without:

| Variable | Meaning |
|----------|---------|
| `PUBLIC_BASE_URL` | Site origin the links point at, e.g. `https://cms.example.com` (never taken from the request's Host header) |
| `SMTP_HOST`, `SMTP_PORT` | SMTP server (default port 587) |
| `SMTP_TLS` | Optional. TLS is required: implicit on port 465, STARTTLS otherwise (a server without STARTTLS is an error). `tls` or `starttls` to choose; `none` only for a loopback relay |
| `SMTP_USER`, `SMTP_PASS` | Optional, set together; only sent over TLS |
| `MAIL_FROM` | Sender, e.g. `GoLive CMS <no-reply@example.com>` |

Optional: `INVITATION_TTL` (default `72h`), `PASSWORD_RESET_TTL` (default `1h`),
`RATE_LIMIT_PASSWORD_FORGOT_PER_MINUTE` (5) and `RATE_LIMIT_ACCOUNT_TOKEN_PER_MINUTE`
(10, reset/accept). Links are single-use, only their SHA-256 is stored, and a
reset signs the user out everywhere. Forgot-password always answers the same way,
whether or not the email has an account.

In development (`compose.dev.yaml`) nothing is sent: each email is written to
`dev-mail/*.eml`. For a web inbox, run Mailpit:
`MAIL_DRIVER=smtp docker compose -f compose.dev.yaml --profile mail up -d` and open
http://localhost:8025.

#### Rate limiting and client IPs

The API limits requests per client IP and answers `429 Too Many Requests` with a
`Retry-After` header (seconds) and `{"error": "..."}` once a limit is used up. Limits
are requests per minute; the whole minute's allowance can be spent at once, then it
refills evenly. `0` turns a limit off.

| Variable | Default | Applies to |
|----------|---------|------------|
| `RATE_LIMIT_GENERAL_PER_MINUTE` | 600 | every `/api/v1` and `/public` request, per IP |
| `RATE_LIMIT_LOGIN_PER_MINUTE` | 10 | `POST /auth/login` per IP *and* username; `POST /auth/register` per IP |
| `RATE_LIMIT_LOGIN_IP_PER_MINUTE` | 100 | `POST /auth/login` per IP across all usernames |
| `RATE_LIMIT_REFRESH_PER_MINUTE` | 30 | `POST /auth/refresh`, per IP |
| `RATE_LIMIT_PASSWORD_CHANGE_PER_MINUTE` | 5 | changing your own password (`PUT /users/:id`), per user and IP |
| `RATE_LIMIT_EXEMPT_CIDRS` | empty | IPs/CIDRs that skip the general limit (auth limits still apply) |

`/health`, `/readyz`, `/uploads` and the internal listener aren't limited. IPv6 clients are
counted per /64, since one host usually holds the whole block. Login is limited per IP
and username, so a few bad guesses against one account can't lock out everyone else
behind the same IP; the looser per-IP cap limits guessing across usernames. Counters
are kept in memory (up to 100,000 clients per limit), so each API process enforces its
own limits. When the admin app's token refresh is rate limited, it stays signed in and
retries after `Retry-After`.

**Client IP and `TRUSTED_PROXIES`.** By default the API trusts no proxy: the client IP
is the TCP peer, and `X-Forwarded-For` / `X-Real-IP` are ignored. Otherwise anyone
could send a new `X-Forwarded-For` with each request and never hit a limit. If the API
runs behind a reverse proxy or load balancer, list its addresses (comma-separated IPs or
CIDRs) in `TRUSTED_PROXIES`, e.g. `TRUSTED_PROXIES=10.0.0.0/8`. Then the client IP is
read from the headers that proxy sets. Without it, every request seems to come from the
proxy and all clients share one allowance.

Requests the web app makes server-side (Astro SSR) all come from the web container's
IP. On a busy site, add that address or its Docker network to
`RATE_LIMIT_EXEMPT_CIDRS`. If browser API calls also pass through the web tier, it
must forward the client IP in `X-Forwarded-For` and be listed in `TRUSTED_PROXIES`.
In development the Vite proxy does that (`xfwd`), and `compose.dev.yaml` trusts the
private Docker ranges. In production browser requests pass Caddy, then the web server,
which forwards `/api/v1` and `/uploads` itself (`web/src/middleware/apiProxy.ts`).
`compose.yaml` pins web to `172.28.0.10` and Caddy to `172.28.0.11`, trusts exactly those
two, and exempts only web (SSR) from the general limit. Caddy discards any
`X-Forwarded-For` the client sends.

#### Health checks, logs and metrics

| Endpoint | Listener | Meaning | Use it for |
|----------|----------|---------|------------|
| `GET /health` (also `/api/v1/health`) | public | liveness: the process serves HTTP | probes that *restart* the container |
| `GET /readyz` | public | readiness: also pings Postgres (2s timeout), 503 if it can't | Docker/compose `healthcheck` (what `depends_on: service_healthy` waits on), load-balancer target checks |
| `GET /metrics` | internal (`:8081`, never published) | Prometheus text: request counts and latency per method, route template and status | scraping from inside the Docker network |

Both compose files healthcheck the API with `/readyz`. Neither health endpoint is rate
limited or returns error details.

Every API response has an `X-Request-ID` header (a well-formed incoming one is kept
only when it comes from a proxy in `TRUSTED_PROXIES`; otherwise a new one is made), and
JSON error bodies include it as `request_id`, so a
user can quote it in a bug report. The API logs one line per request: JSON in release
mode, readable text in debug mode, with the request id, method, route template (never
the raw path or query string), status, latency and the caller's user id. Headers,
cookies, tokens, passwords and request bodies are never logged, and client IPs only in
debug mode. The collab WebSocket server logs `ws_upgrade` / `ws_connect` / `ws_deny` /
`ws_close` as JSON lines, and forwards its request id to the API's role lookup, so both
sides of a connection can be found by one id.

Error tracking (Sentry and the like) plugs in through `api.ErrorReporter`
(`server.SetErrorReporter`). It receives recovered panics and 5xx responses. The
default does nothing.

### Database Management

```bash
make postgres      # Start standalone PostgreSQL container
make createdb      # Create database
make dropdb        # Drop database
make migrateup     # Run all migrations
make migratedown   # Rollback all migrations
```

Backups, restore, and running migrations in production:
[docs/operations/backups.md](docs/operations/backups.md).

### Code Generation & Testing

```bash
make sqlc          # Generate Go code from SQL queries
make mock          # Generate mocks for testing
make test          # Run all tests
make server        # Run API server locally (without Docker)
```

### Documentation

```bash
make install-godoc # Install godoc tool
make docs          # Start documentation server on http://localhost:6060
```

The documentation will be available at:

- **Package Documentation**: http://localhost:6060/pkg/github.com/go-live-cms/go-live-cms/
- **Util Package**: http://localhost:6060/pkg/github.com/go-live-cms/go-live-cms/util/

## 📁 Project Structure

```
golive-cms/
├── api/                    # API handlers and routes
├── db/
│   ├── migration/         # Database migrations
│   ├── query/            # SQL queries for sqlc
│   └── sqlc/             # Generated Go code from SQL
├── token/                 # PASETO token handling
├── util/                  # Utility functions
├── web/                   # Astro frontend application
└── main.go               # API server entry point
```

## 🗄️ Database Development

### Creating New Migrations

1. **Create migration files:**

   ```bash
   migrate create -ext sql -dir db/migration -seq add_new_table
   ```

   This creates two files:

   - `000002_add_new_table.up.sql` (schema changes)
   - `000002_add_new_table.down.sql` (rollback changes)

2. **Write your SQL in the `.up.sql` file:**

   ```sql
   CREATE TABLE "new_table" (
     "id" BIGSERIAL PRIMARY KEY,
     "name" varchar NOT NULL,
     "created_at" timestamptz NOT NULL DEFAULT (now())
   );
   ```

3. **Write rollback SQL in the `.down.sql` file:**

   ```sql
   DROP TABLE IF EXISTS "new_table";
   ```

4. **Apply migration:**
   ```bash
   make migrateup
   ```

### Creating New Database Queries

1. **Add SQL queries to appropriate file in `db/query/`:**

   ```sql
   -- db/query/new_table.sql

   -- name: CreateNewRecord :one
   INSERT INTO new_table (name) VALUES ($1) RETURNING *;

   -- name: GetNewRecord :one
   SELECT * FROM new_table WHERE id = $1 LIMIT 1;

   -- name: ListNewRecords :many
   SELECT * FROM new_table ORDER BY id LIMIT $1 OFFSET $2;
   ```

2. **Generate Go code:**
   ```bash
   make sqlc
   ```
   This generates methods in `db/sqlc/` that you can use in your handlers.

### Installing Dependencies

#### Go Dependencies

```bash
go mod tidy
```

#### sqlc (for generating Go code from SQL)

```bash
# On WSL/Ubuntu
sudo snap install sqlc

# Alternative: using Go
go install github.com/sqlc-dev/sqlc/cmd/sqlc@latest
```

#### migrate (for database migrations)

```bash
# On WSL/Ubuntu
curl -L https://github.com/golang-migrate/migrate/releases/download/v4.14.1/migrate.linux-amd64.tar.gz | tar xvz
sudo mv migrate.linux-amd64 $GOPATH/bin/migrate
migrate --version
```

## 🛣️ Adding New API Endpoints

### 1. Create the Handler

Add your handler function to the appropriate file in `api/`:

```go
// api/new_resource.go
func (server *Server) createNewResource(c *gin.Context) {
    // Your handler logic here
    c.JSON(http.StatusOK, gin.H{"message": "success"})
}
```

### 2. Add Route to Server

In `api/server.go`, add your route to the `setupRoutes()` function:

```go
func (server *Server) setupRoutes() {
    // ... existing code ...

    newResource := v1.Group("/new-resource")
    newResource.POST("", server.createNewResource)           // POST /api/v1/new-resource
    newResource.GET("", server.getNewResources)             // GET /api/v1/new-resource
    newResource.GET("/:id", server.getNewResourceByID)      // GET /api/v1/new-resource/:id
    newResource.PUT("/:id", server.updateNewResource)       // PUT /api/v1/new-resource/:id
    newResource.DELETE("/:id", server.deleteNewResource)    // DELETE /api/v1/new-resource/:id
}
```

### 3. Test Your Endpoint

```bash
# Test with curl
curl -X GET http://localhost:8080/api/v1/new-resource

# Or check the health endpoint
curl http://localhost:8080/health
```

## 🌟 Astro Frontend Development

### Project Structure

```
web/
├── src/
│   ├── components/        # Reusable Astro/React components
│   ├── layouts/          # Page layouts
│   ├── pages/            # Routes (file-based routing)
│   │   └── api/         # API endpoints (Astro server-side)
│   ├── lib/             # Utilities and API client
│   └── styles/          # Global styles
├── public/              # Static assets
└── astro.config.mjs     # Astro configuration
```

### Key Technologies

- **Astro**: Static site generator with partial hydration
- **React**: For interactive components
- **Tailwind CSS**: Utility-first CSS framework
- **MDX**: Markdown with JSX support

### Development Commands

```bash
cd web

# Development
npm run dev              # Start dev server (localhost:4321)
npm run dev:docker       # Start dev server for Docker (0.0.0.0:4321)

# Build
npm run build           # Build for production
npm run preview         # Preview production build

# Other
npm run astro           # Run Astro CLI commands
```

### Adding New Pages

1. **Create a new page in `src/pages/`:**

   ```astro
   ---
   // src/pages/my-new-page.astro
   import Layout from '../layouts/Layout.astro';
   ---

   <Layout title="My New Page">
     <h1>Welcome to my new page!</h1>
   </Layout>
   ```

2. **For dynamic routes, use brackets:**
   ```astro
   // src/pages/blog/[slug].astro - matches /blog/anything
   // src/pages/users/[id].astro - matches /users/123
   ```

### API Integration

The frontend communicates with the Go API using the client in `src/lib/api.ts`:

```typescript
// Example API call
import { apiClient } from "../lib/api";

const posts = await apiClient.get("/posts");
```

### Adding Interactive Components

1. **Create React component:**

   ```jsx
   // src/components/InteractiveButton.jsx
   import { useState } from "react";

   export default function InteractiveButton() {
     const [count, setCount] = useState(0);

     return (
       <button onClick={() => setCount(count + 1)}>
         Clicked {count} times
       </button>
     );
   }
   ```

2. **Use in Astro page:**

   ```astro
   ---
   import InteractiveButton from '../components/InteractiveButton.jsx';
   ---

   <InteractiveButton client:load />
   ```

### Environment Variables

- `SERVER_API_URL`: the API base the **server** (SSR) calls, read at runtime, e.g.
  `http://api:8080/api/v1` (set in both compose files)
- `PUBLIC_API_URL`: the **browser-facing** API URL, only used for the admin CSP. Leave it
  unset in production: the browser calls `/api/v1` same-origin. See
  `docs/operations/deploy.md`.
- Add more in `astro.config.mjs` or `.env` files

## 🧪 Testing

```bash
# Run all Go tests
make test

# Run with coverage
go test -v -cover -coverprofile=coverage.out ./...

# View coverage in browser
go tool cover -html=coverage.out
```

### CI

`.github/workflows/ci.yml` runs on every PR to `main` and every push to `main`. The
jobs run in parallel:

| Job | What it checks |
|-----|----------------|
| Test | `go build`, migrations, `make coverage-check` against Postgres 12 |
| Go lint | `go vet`, `gofmt -l` (fails on unformatted files), golangci-lint (`.golangci.yml`) |
| sqlc in sync | `sqlc diff`: `db/sqlc` must match `db/query` + `db/migration` (regenerate with `make sqlc`) |
| Migrations up/down/up | every up, then every down (nothing may be left behind), then up again with an identical schema dump |
| Web tests | `web` vitest and `websocket` `node --test` |
| Web type check and build | `astro check` and `astro build` |
| Docker image | builds the api, web and websocket production images (no push) |

To reproduce locally before pushing:

```bash
gofmt -l .                      # must print nothing
go vet ./...
golangci-lint run               # v2, see the version in ci.yml
sqlc diff
cd web && npm run check && npm run build
```

**Secrets.** CI needs no repository secrets. The Postgres credentials in the workflow
belong to a throwaway service container, and the token is read-only
(`permissions: contents: read`). Nothing is pushed or deployed. Don't print secrets or
env dumps in a step. A future deploy job should take its credentials from GitHub
Actions secrets (`secrets.*`) on the step that uses them, and from a protected
environment. Runtime secrets (`ROLE_LOOKUP_SECRET`, `COLLAB_INTERNAL_SECRET`, the
`PASETO_V4_*` keys, the DB password) come from the deployment's environment. They are
never baked into images: the API image no longer copies `app.env`, and `.dockerignore`
keeps it out of the build context.

## 🐛 Troubleshooting

### Common Issues

1. **Port conflicts**: Make sure ports 5432, 8080, and 4321 are available
2. **Database connection**: Wait for PostgreSQL to be healthy before starting API
3. **Hot reload not working**: The setup uses polling for file watching in Docker

### Useful Commands

```bash
# Check running containers
docker ps

# View database
docker exec -it <postgres_container> psql -U root -d golive_cms

# Reset everything
make devdown
docker system prune -f
make dev
```

## 📚 Additional Resources

- [Gin Documentation](https://gin-gonic.com/docs/)
- [SQLC Documentation](https://docs.sqlc.dev/)
- [Astro Documentation](https://docs.astro.build/)
- [Tailwind CSS](https://tailwindcss.com/docs)
- [Migrate Documentation](https://github.com/golang-migrate/migrate)
