# Go backend — agent context

Gin HTTP API. Type-safe DB via **sqlc** (no ORM). **PASETO v4** auth (not JWT).
Postgres. Tests use generated mocks.

## Layout & conventions

Each domain (posts, users, sessions, taxonomies, media, themes, settings, post_types)
is split into consistently-named files in `api/`:

- `*_handlers_read.go` / `*_handlers_write.go` — GET vs mutating handlers
- `*_bindings.go` — request structs + Gin binding/validation tags
- `*_presenters.go` — response shaping
- `*_routes.go` — route registration (called from `server.go`)
- `*_utils.go` — domain helpers

`server.go` builds the Gin engine, CORS, and registers all route groups under
`/api/v1` (+ a `/public` group for SSR). Auth via
`authMiddleware(server.tokenMaker, server.store)`; the payload is under context key
`authorization_payload` (`getAuthPayload(c)`).

> Note: `media` is the one domain whose handler split is incomplete (some handlers
> still in `api/media.go`). Tracked in a GitHub issue.

## Database / sqlc workflow

- SQL lives in `db/query/*.sql`; **edit those, then regenerate** the Go in `db/sqlc/`
  (`make` target / `sqlc generate`). Don't hand-edit `db/sqlc/*.sql.go`.
- Migrations in `db/migration/` (`000001`…). `make migrateup` / `migratedown`.
- `db/mock/store.go` is the generated `MockStore` used by handler tests.
- The transaction `Store` interface wraps the DB; handlers depend on it.

## Auth

PASETO v4: asymmetric (`PASETO_V4_PUBLIC/PRIVATE_KEY_HEX`) for access tokens, local
symmetric (`PASETO_V4_LOCAL_KEY_HEX`) for refresh. Issuer/audience/KIDs in `util/config.go`.
The WebSocket server never sees access tokens (#233). The editor exchanges its access
token for a **collab ticket** at `POST /collab/tickets` (admin/editor): v4.public, signed
with the access key, audience `golive.admin-ws`, `token_type: ws_ticket`, `doc` claim,
30s TTL (`token/ws_ticket.go`, `collab_*.go`). `VerifyToken` rejects tickets, so they're
not bearer tokens. The API never accepts a ticket back: the WS server verifies it
locally, burns its jti (single use, in the WS process), and gets the user's current
role from the internal role endpoint below (#223). The ticket never leaves the WS
server.

- **`authMiddleware` loads the caller's DB row on every authenticated request** and
  caches it under `authorization_user`. Get it with `server.callerUser(c)`; don't
  call `GetUser` for the caller again. A deleted user's still-valid token gets **403**.
- **Roles** live only in `auth_roles.go` (`requireSiteAdmin`, `requireContentEditor`,
  and `isSiteAdmin`/`hasRole` for inline self-or-admin checks). Never compare
  role strings elsewhere; the token's `role` claim is informational only.
- **Password change revokes everything.** `UpdateUserTx{PasswordChanged: true}`
  locks the user row, stamps `password_changed_at` itself, and blocks every
  session. `authMiddleware` then rejects access tokens whose `iat` is before
  `password_changed_at` (401). The comparison is per second because PASETO `iat`
  has no fractional part, so a token issued earlier in the *same* second survives.
  Refresh rotation takes the user row `FOR SHARE` and mints its access token
  before committing, so it can't slip a token past a concurrent change. Don't
  set `password_changed_at` in a handler.
- **Self password change** (`PUT /users/:id` with `password`) requires
  `current_password` (403 if missing/wrong). The refresh cookie is scoped to
  `/api/v1/auth`, so the request can't tell which session sent it. Instead the
  response sets a fresh refresh cookie and returns a new `access_token` (the
  admin UI adopts it). An admin resetting someone else's password needs no
  current password.
- **Refresh reuse vs revoked:** a blocked session's refresh token is only treated
  as *reuse* (409, blocks all sessions) if the session was rotated (`replaced_by`
  set). A session blocked by logout or a password change just gets 401.

## Tests

- `go test ./...` (or `make test`). Handler tests use `MockStore`; `db/sqlc/*_test.go`
  run against a real Postgres test DB.
- CI (`.github/workflows/ci.yml`) runs the Go suite with a Postgres service.

## Collaboration integration (squash-on-publish)

- After a successful publish, `triggerCollabSquash(postID)` fires a **best-effort**
  goroutine to the WS server's `/_internal/documents/post-<id>/squash` endpoint to
  compact its LevelDB log. Never blocks/fails the publish.
- Config: `COLLAB_SERVER_URL` + `COLLAB_SQUASH_SECRET` in `util/config.go`. **Both
  default to empty (opt-in)** — if either is unset, squash is silently skipped. The URL
  is trailing-slash-trimmed before building the request.

## Collaboration integration (WS role lookup, #223)

- `GET /internal/users/:id/role?issued_at=<unix>` (`internal_routes.go`,
  `internal_handlers_read.go`) is the WS server's per-connection role check.
- **It is on a separate listener, not under `/api/v1`.** `newInternalRouter` builds its
  own Gin engine and `main.go` serves it with `StartInternal(INTERNAL_SERVER_ADDRESS)`
  (default `0.0.0.0:8081`). Never publish that port (compose doesn't). The public
  router answers 404 for `/internal/*` and `/api/v1/internal/*` (tested). Put any new
  server-to-server route there, not on `v1`.
- It is
  authenticated with `Authorization: Bearer <ROLE_LOOKUP_SECRET>` (constant-time
  compare), **not** `authMiddleware`, so it works with WS-only tickets
  (`golive.admin-ws`, `token_type: ws_ticket`, #233). The WS server passes the
  ticket's `user_id` and `iat`. It reads the role from the DB and refuses (403) tickets
  issued before the user's latest password change. 404 means the user is gone.
- `ROLE_LOOKUP_SECRET` is **required**: `NewServer` errors without it. It has no
  default, so `LoadConfig` binds it with `viper.BindEnv`. Without that, viper's
  `Unmarshal` drops env-only keys it doesn't know (see `util/config_test.go`).
  `NewServer` trims it once, and the WS server trims its copy too, so stray whitespace
  in `app.env` can't make the two sides disagree.

## Gotchas

- `block_doc` (jsonb on `posts`) is the **working copy** the editor loads;
  `published_block_doc` is the published snapshot the public frontend reads. They can
  diverge (a bug can wipe the working copy while the published one stays intact).
- `TOKEN_SYMMETRIC_KEY` is legacy/unused (pre-PASETO); slated for removal.
</content>
