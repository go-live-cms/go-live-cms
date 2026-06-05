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
`/api/v1` (+ a `/public` group for SSR). Auth via `authMiddleware(tokenMaker)`; the
payload is under context key `authorization_payload` (`getAuthPayload(c)`).

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
The WebSocket server verifies the **same** public-key tokens (audience `golive.admin-ws`,
also accepts `golive.admin`/`golive.auth` during migration).

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

## Gotchas

- `block_doc` (jsonb on `posts`) is the **working copy** the editor loads;
  `published_block_doc` is the published snapshot the public frontend reads. They can
  diverge (a bug can wipe the working copy while the published one stays intact).
- `TOKEN_SYMMETRIC_KEY` is legacy/unused (pre-PASETO); slated for removal.
</content>
