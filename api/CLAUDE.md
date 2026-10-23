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

Some domains also keep a docs-only module entry file (`posts.go`, `users.go`,
`media.go`, `taxonomies.go`, `sessions.go`, `themes.go`) holding package-level docs
and no code. `post_types.go` is not one of them: it contains code.

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
token for a **collab ticket** at `POST /collab/tickets` (`canEditPost` on the doc's post): v4.public, signed
with the access key, audience `golive.admin-ws`, `token_type: ws_ticket`, `doc` claim,
30s TTL (`token/ws_ticket.go`, `collab_*.go`). `VerifyToken` rejects tickets, so they're
not bearer tokens. The API never accepts a ticket back: the WS server verifies it
locally, burns its jti (single use, in the WS process), and asks the internal access
endpoint below whether the user may edit that doc (#223, #135). The ticket never leaves
the WS server.

- **`authMiddleware` loads the caller's DB row on every authenticated request** and
  caches it under `authorization_user`. Get it with `server.callerUser(c)`; don't
  call `GetUser` for the caller again. A deleted user's still-valid token gets **403**.
- **Roles** live only in `auth_roles.go` (`requireSiteAdmin`, `requireContentEditor`,
  `isSiteAdmin`/`hasRole` for inline self-or-admin checks, and
  `canModerateMedia`/`canWriteMedia` for media ownership). Never compare
  role strings elsewhere; the token's `role` claim is informational only.
- **Document permissions (#135)** live only in `auth_posts.go`, the per-post sibling
  of `auth_roles.go`. Model: **ownership** (`posts.user_id` is the owner).
  - Admins/editors (`canModeratePosts`) may do anything to any post.
  - Contributors may create posts, but only drafts authored by themselves
    (`canCreatePost`). They may edit their own posts' **working copy** (`PUT
    /blocks`, the collab socket: `canEditPost`) at any status.
  - The **live** fields (PUT `/posts/:id`, meta, featured image, media links, DELETE)
    only while their post isn't published (`canEditPostDetails`). Otherwise they could
    change or remove published content without the publish permission. For the same
    reason a blocks PUT on their published post refuses a changed title (403, nothing
    saved; the unchanged title every autosave sends is fine) and doesn't sync
    `post_media` (publish does), and PUT `/posts/:id` refuses a `post_status` change
    (403) from anyone who can't publish. A `post_parent` must be a post the caller can
    edit (`canEditPost`).
  - Publish/unpublish/revisions stay `requireContentEditor`.
  - Per-post write routes use `requireContentAuthor` (any content role) plus, in the
    handler, `server.authorizePost(c, id, rule)` (skips the post lookup for moderators;
    404 for a missing post, 403 when refused). Use `server.checkPost` when the handler
    already loaded the post, and `authorizeLoadPost` to reuse the row it loads.
  - Never compare `post.UserID` or roles in a handler. Block-level permissions and
    org/site scoping are out of scope.
- **Media ownership:** admins and editors may update/delete any media; any other
  role only its own (`canWriteMedia`, used by both PUT and DELETE `/media/:id`).
  Every content role may upload (`requireContentAuthor`, #135).
  DELETE removes the stored file after the transaction commits, but only when
  `media_path` resolves inside `UploadPath` (`removeMediaFile`). PUT rejects
  `media_path`, but old/seeded rows may hold anything, so keep that check.
- **Image pipeline (#255, `media_variants.go`, `media_metadata.go`):** upload and
  Replace strip the original's EXIF/GPS/XMP/text metadata losslessly (a JPEG keeps
  only its orientation) and generate `thumb`/`medium`/`large` variants (320/800/1600
  long edge, never upscaled, pure Go via `golang.org/x/image`, JPEG or PNG if
  transparent) in `<dir>/_variants/<file>/`. They're **staged** and only moved into
  place once the DB agrees (`stagedVariants.commit`), so a failed Replace keeps the
  old set; Delete removes the directory (`removeMediaVariants`). The `variants`
  column (jsonb, `{}` = none) and `focal_x`/`focal_y` (0..1, both or neither; CHECK
  constraint) are returned as `variants` / `focal_point`. `variants` is
  server-owned (PUT → 400); `focal_point` is set by PUT (`null` clears, absent
  keeps). Existing media: `main backfill-variants [-all]` (debug startup runs it
  after seeding). It runs outside the API process, so it writes through
  `SetMediaVariantsTx` (row `FOR UPDATE`, skip if `media_path`/`changed_at`
  changed): a concurrent Replace always wins. Image decoding is capped at two at
  a time (`imagePipelineSlots`). Published docs served by `GET /posts/:id`, `/posts/slug/:slug`
  and `/public/posts/:id/blocks` get a derived `media` map for image blocks
  (`post_block_media.go`) so the renderer can emit `srcset` and `object-position`.
- **`media_path` in responses is a URL path, not the stored value.** The DB holds
  the filesystem path (`<UPLOAD_PATH>/<file>`, e.g. `/app/uploads/media/x.jpg` in
  compose); responses map it to where `/uploads` serves it (`/uploads/media/x.jpg`)
  via `server.mediaResponse` / `publicMediaPath`. The admin uses it directly as the
  image URL, so never return a media row through bare `toMediaResponse`.
- **Password change revokes everything.** `UpdateUserTx{PasswordChanged: true}`
  locks the user row, stamps `password_changed_at` itself, and blocks every
  session. `authMiddleware` then rejects access tokens whose `iat` is before
  `password_changed_at` (401). The comparison is per second because PASETO `iat`
  has no fractional part, so a token issued earlier in the *same* second survives.
  Refresh rotation takes the user row `FOR SHARE` and mints its access token
  before committing, so it can't slip a token past a concurrent change. Don't
  set `password_changed_at` in a handler.
- **Self password change** (`PUT /users/:id` with `password`) requires
  `current_password` (403 if missing/wrong). The non-Secure dev refresh cookie
  is scoped to `/api/v1/auth`, so the handler can't rely on seeing it and can't
  tell which session sent the request. Instead the
  response sets a fresh refresh cookie and returns a new `access_token` (the
  admin UI adopts it). An admin resetting someone else's password needs no
  current password.
- **Refresh reuse vs revoked:** a blocked session's refresh token is only treated
  as *reuse* (409, blocks all sessions) if the session was rotated (`replaced_by`
  set). A session blocked by logout or a password change just gets 401.

## Tests

- `go test ./...` (or `make test`). Handler tests use `MockStore`; `db/sqlc/*_test.go`
  run against a real Postgres test DB.
- CI (`.github/workflows/ci.yml`) runs the Go suite with a Postgres service via
  `make coverage-check`, which fails if total coverage drops below `COVERAGE_MIN`
  in the Makefile. Raise the floor when coverage goes up; never lower it to pass.
- sqlc integration tests share one DB across runs and are not cleaned up: use
  unique values (UUID/UnixNano suffixes) and restore global state such as the
  active theme with `t.Cleanup`.

## Collaboration backend: `COLLAB_BACKEND` (#206, #280)

`y-websocket` (default, today's behaviour) or `hocuspocus` (`util.Config.UsesHocuspocus()`;
`LoadConfig` rejects anything else, the zero `Config` in tests is y-websocket). It is
deployment-wide and must match web's `PUBLIC_COLLAB_BACKEND`. **Everything Hocuspocus-only
checks the flag**, so main behaves exactly as before until the P4 cutover.

- **API → collab calls** (`collab_internal_client.go`) use `COLLAB_INTERNAL_URL` +
  `COLLAB_INTERNAL_SECRET` (Bearer; renamed from `COLLAB_SERVER_URL` /
  `COLLAB_SQUASH_SECRET`). `NewServer` trims both (URL also of trailing `/`) and, under
  hocuspocus, refuses to start without them. The secret is NOT the one the collab
  server sends to the API (that's `ROLE_LOOKUP_SECRET`).
  - y-websocket: after a publish, `triggerCollabSquash` fires a **best-effort** goroutine
    to `/_internal/documents/post-<id>/squash` (LevelDB compaction). Skipped if either
    setting is unset; never blocks/fails the publish.
  - hocuspocus: **before** reading `block_doc`, publish calls
    `POST /internal/documents/post-<id>/flush` synchronously (`collabFlushTimeout`, 5s).
    200 = stored or not loaded. Anything else (down, timeout, non-200) → **503**, nothing
    published, so a snapshot never misses the last debounced edits. No squash.
- **Collab → API** (internal listener, `ROLE_LOOKUP_SECRET`, `internal_handlers_collab.go`):
  - `GET /internal/posts/:id/collab` → `{block_doc, block_revision, ydoc_state?, epoch?}`
    (`ydoc_state` base64). **Revision guard is applied here:** the state is returned only
    if `post_ydoc_state.block_revision == posts.block_revision`; otherwise something wrote
    `block_doc` around the collab server and the state is omitted, so the server reseeds
    under a new epoch. Works under either backend (read-only).
  - `PUT /internal/posts/:id/collab {state, epoch, block_doc?, last_editor_id?, base_revision?}`
    → `{block_revision, epoch}`. **Hocuspocus only** (409 otherwise: two block_doc writers).
    16 MiB body (`collabStoreBodyLimit`), `block_doc` itself ≤ 4 MiB, and the same
    `prepareForStore` as `PUT /blocks` (limits, dedupe `blocks_order`, sanitize, v1 +
    order integrity). `block_doc` omitted/null = store the Yjs state only (server-side
    validation failed), revision unchanged; that **requires `base_revision`** (400
    otherwise), or a stale state could be stamped with the current revision and pass the
    guard. `base_revision` behind → 409. 404 for a missing post.
  - `StorePostCollabTx` (`db/sqlc/post_collab_tx.go`) is one transaction: lock the post,
    `block_doc` + `block_revision+1`, sync content media links (`SyncPostContentMedia`:
    unknown media ids skipped, featured image untouched; **only while unpublished**, publish
    syncs them otherwise), upsert `post_ydoc_state` (`000020`) at the new revision with
    `last_editor_id` (NULL if the user is gone).
- **`PUT /posts/:id/blocks` answers 409 `managed by collaboration server`** under
  hocuspocus (an old tab can't overwrite). GET stays. Removed in P5.
- **Tickets:** under hocuspocus `POST /collab/tickets` uses `canReadPostBlocks` (any content
  role, any existing post) instead of `canEditPost`: contributors get a read-only live
  view of others' posts. The ticket still carries no role; the server asks
  `/internal/users/:id/access` and makes `can_edit: false` connections read-only.

## Gin mode, dev seeding, CORS

- `GIN_MODE` (`util.Config.GinMode`) defaults to **release**; `main.go` applies it.
  Only `compose.dev.yaml` sets `debug`. An invalid value fails `LoadConfig`.
- Debug mode seeds `admin`/`123456` + dummy data on startup (`shouldSeedDevData`)
  and allows the local `:4321` origins. `go run ./cmd/seed` (`make seed`/`devseed`,
  #130) runs the same seeders explicitly and refuses outside debug mode without
  `-force`. `SEED_ADMIN_USER`/`SEED_ADMIN_PASS` override the admin credentials.
- **Seeded media (#201)** are the embedded `devModeUtil/sampleimages/*.jpg`, written
  into `UPLOAD_PATH` as given (never `filepath.Join(".", …)`: that turned compose's
  absolute `/app/uploads/media` relative) with `media_path` in the same
  `<UPLOAD_PATH>/<file>` form as uploads. A same-named file that isn't the seed's
  is never reused or overwritten (`sample-image-N_1.jpg` instead). Only `cmd/seed`
  restores missing files, and only ones a media row references
  (`RestoreSampleMediaFiles` via `ListMediaPathsIn`); startup never writes them. Gate dev-only behaviour on
  `config.IsDebugMode()`, **not** `gin.Mode()` (global state, and tests set it).
- **Outside debug mode, `NewServer` refuses to start** if a seeded account
  (`admin`/`123456`, or the dummy `editor`/`author`/`contributor`/`moderator` with
  `password123`) still has its seeded password (`checkSeededAccounts`), or if the
  lookup fails. Older versions always ran in debug mode, so real deployments
  have these accounts. Seeded credentials live in `devModeUtil/seeded_accounts.go`;
  add any new seeded account there. A `SEED_ADMIN_USER` account is also checked
  against the default password (`ConfiguredAdminAccounts`). Recovery steps: readme "Seeded dev accounts in
  production". `NewServer` tests that turn test mode off must expect these lookups.
- CORS origins come from `CORS_ALLOWED_ORIGINS` (comma-separated). In release with
  none set, no CORS middleware is installed (same-origin only).
- **Cookies:** the refresh cookie is always `Secure` outside debug mode
  (`applyCookieSecurity` in `sessions_cookies.go`). Only in debug does
  `COOKIE_SECURE` (default false) decide it, so local HTTP works. There is no
  separate `IS_DEVELOPMENT` switch any more (#236): debug mode *is* development.
- **Refresh cookie name (#159):** when Secure it is `__Host-refresh_token`,
  Path=/, no Domain (`COOKIE_DOMAIN` ignored). Only the non-Secure dev cookie is
  `refresh_token`, Path=`/api/v1/auth`. Never use the name constants directly:
  set/clear/read with `setRefreshCookie` / `clearRefreshCookie` /
  `readRefreshCookie`, which pick the name from the mode. With the `__Host-`
  cookie in use they also expire a pre-#159 `refresh_token` cookie, but only
  when the request carries one. A non-localhost `COOKIE_DOMAIN` is ignored
  then, and `NewServer` prints a warning. The admin
  reaches the API through the web origin's `/api` proxy, so the cookie belongs
  to the web host and (Path=/) is sent with every request to it.
- **Security headers (#157):** `securityHeadersMiddleware` (first in
  `setupRoutes`) sets nosniff, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer` and a `default-src 'none'` CSP on every
  response, `/uploads` included. HSTS only outside debug mode, and without
  `includeSubDomains` (it reaches the site's host through the `/api` proxy,
  which may be the apex domain). Don't add a
  `Cross-Origin-Resource-Policy`: the web app loads `/uploads` cross-origin.

## Invitations, password reset, mail (#148)

- **Invite-only.** Admins create invitations (`/invitations`, `invitations_handlers_{read,write}.go`);
  `POST /auth/invitations/accept` creates the user with the invitation's email and
  role. `/auth/register` is still a placeholder (self-registration is Post-MVP, #191).
- **Tokens** (`account_tokens_utils.go`): 32 random bytes, base64url; only the
  SHA-256 is stored (`user_invitations`, `password_reset_tokens`). Redeeming is one
  `UPDATE ... RETURNING` claim (`ClaimUserInvitation`, `ClaimPasswordResetToken`),
  so single use holds under concurrency. Every bad-token case answers the same
  400 `invalid_token`. Links put the token in the `#fragment`; the web pages POST it.
  **Never log tokens or message bodies.**
- **Reset = password change.** `ResetPasswordTx` locks the user row (user → token
  rows, same order as `UpdateUserTx`), stamps `password_changed_at`, blocks every
  session and burns the user's other reset tokens. `UpdateUserTx` with
  `PasswordChanged` burns outstanding reset tokens too.
- **Forgot never enumerates:** same 200 for any address, and the lookup/token/email
  run after the response (`server.runInBackground` → `runDetached`, which recovers
  and reports panics; inline in tests). One email per
  user per minute (silent cooldown).
- **Mailer** (`mailer/`): `smtp` | `file` (debug default, `dev-mail/*.eml`) | `log`
  (test default). Outside debug/test `NewServer` fails without `SMTP_HOST`,
  `MAIL_FROM` and `PUBLIC_BASE_URL`, and refuses `file`/`log`. SMTP requires TLS
  (`SMTP_TLS`: STARTTLS by default, a server without it is an error; `none` only in
  debug/test or to a loopback relay). Links are built from
  `PUBLIC_BASE_URL`, never the Host header. Templates in `mailer/templates/`
  (text + HTML, site title from settings).

## Request validation and hardening (#139)

- **Bind JSON with `bindJSON(c, &req)`** (`request_binding.go`), never `ShouldBindJSON`.
  It rejects unknown fields and trailing data, and writes every error as
  `{"error": "<field> <message>", "fields": {"<json name>": "<message>"}}` without Go
  struct names or types. Use `bindOptionalJSON` when the body may be omitted, and
  `respondBindError` for a multipart `ShouldBind` error. A field a known client sends
  but the API ignores must be declared (e.g. posts' `content`), or that client breaks.
- Custom validator tags: `slug`, `identifier` (post type names; never a path),
  `setting_key` (meta/setting keys), `max_bytes=N` (passwords: bcrypt reads 72 bytes).
  URLs use `http_url` (http/https only). Give every string a `max`.
- **Body limits** (`request_limits.go`): 1 MiB default on `/api/v1` and `/public`, 4 MiB
  for `PUT /posts/:id/blocks`, uploads exempt (they cap themselves). The internal listener
  has no group limit; `PUT /internal/posts/:id/collab` caps itself (16 MiB). A new upload route
  must be added to `bodyLimitOverrides` with 0. Block docs also get
  `checkLimits` (block count, block id length, JSON depth).
- **CORS:** `CORS_ALLOWED_ORIGINS` entries must be exact http(s) origins (no `*`, path
  or trailing slash), checked in `setupRoutes`. They are the admin's origins and get
  credentials; the public site renders server-side and needs no CORS.
- **CSRF:** `cookieOriginGuard` (`origin_guard.go`) on login/refresh/logout refuses
  cross-origin browser requests (Sec-Fetch-Site, else Origin vs Host /
  trusted-proxy X-Forwarded-Host), on top of SameSite=Strict + `__Host-`.
- **Key rotation:** `PASETO_V4_PREVIOUS_{PUBLIC,LOCAL}_KEY_HEX` +
  `PASETO_PREVIOUS_KEYS_VALID_UNTIL` keep retired keys verifying until the cutoff
  (`token/paseto_v4_rotation.go`, `docs/operations/key-rotation.md`).

## Rate limiting and client IP (#190, #156)

- `ratelimit.go`: a general per-IP limit on the `/api/v1` and `/public` groups, plus
  stricter per-IP limits on `/auth/register` and `/auth/refresh`. Login has a per-IP
  cap plus a **per IP+username** limit checked in `loginUser` after binding. Self
  password changes have a **per user+IP** limit inside `updateUser`, because only the
  body says whether a password is changing. Per-user-only keys would let an attacker
  lock the owner out, so don't use them. 429 +
  `Retry-After` + `{"error": ...}`. Limits are per minute from `RATE_LIMIT_*` in
  `util/config.go`, and 0 disables one. **A zero `Config` (tests) has every limit off**,
  so existing handler tests aren't throttled; rate-limit tests set them explicitly.
- Counters are in memory (`memoryRateLimitStore`, x/time/rate, 32 locked shards,
  idle buckets evicted after a minute, LRU eviction past 100k keys) behind
  `RateLimitStore`, the seam for Redis/Valkey (#185). Key clients with `clientKey`
  (IPv6 → its /64), not the raw IP.
- **`ctx.ClientIP()` only reads X-Forwarded-For from `TRUSTED_PROXIES`** (none by
  default; `SetTrustedProxies` in `setupRoutes`, which returns its error to
  `NewServer`; `nil` on the internal router). Don't parse forwarding headers yourself.
  Dev compose trusts the private Docker ranges because the Vite proxy sets XFF.
- The internal listener is not limited on purpose (see the `ratelimit.go` header).

## Collaboration integration (WS access lookup, #223, #135)

- `GET /internal/users/:id/access?doc=post-<id>&issued_at=<unix>` (`internal_routes.go`,
  `internal_handlers_read.go`) is the WS server's per-connection check. It answers
  `{role, can_edit}`, where `can_edit` is `canEditPost` for that post (moderators skip
  the post lookup). 404 if the user, or for a contributor the post, is gone. It replaced
  the role-only `/internal/users/:id/role`; Hocuspocus's `onAuthenticate` (#206) should
  call this same endpoint.
- **It is on a separate listener, not under `/api/v1`.** `newInternalRouter` builds its
  own Gin engine and `main.go` serves it with `StartInternal(INTERNAL_SERVER_ADDRESS)`
  (default `0.0.0.0:8081`). Never publish that port (compose doesn't). The public
  router answers 404 for `/internal/*` and `/api/v1/internal/*` (tested). Put any new
  server-to-server route there, not on `v1`.
- It is
  authenticated with `Authorization: Bearer <ROLE_LOOKUP_SECRET>` (constant-time
  compare), **not** `authMiddleware`, so it works with WS-only tickets
  (`golive.admin-ws`, `token_type: ws_ticket`, #233). The WS server passes the
  ticket's `user_id`, `iat` and `doc`. It reads the role (and owner) from the DB and
  refuses (403) tickets issued before the user's latest password change.
- `ROLE_LOOKUP_SECRET` is **required**: `NewServer` errors without it. It has no
  default, so `LoadConfig` binds it with `viper.BindEnv`. Without that, viper's
  `Unmarshal` drops env-only keys it doesn't know (see `util/config_test.go`).
  `NewServer` trims it once, and the WS server trims its copy too, so stray whitespace
  in `app.env` can't make the two sides disagree.

## Observability (#142, #155)

- **Middleware order** (both routers): `requestIDMiddleware` → `requestLogger` →
  `recoveryMiddleware`, before security headers/CORS, so preflights, 429s and panics
  are logged and carry `X-Request-ID`. `gin.Default()`/`gin.Logger()` are not used.
- **Request id:** a well-formed incoming `X-Request-ID` (`[A-Za-z0-9._:-]{8,128}`) is
  kept only from a peer in `TRUSTED_PROXIES` (public router) or on the internal
  listener; anything else gets a UUID, so clients can't choose their ids. Read it with `requestIDFromContext(c)`. `requestIDErrorWriter`
  splices `"request_id"` into every JSON error body (status ≥ 400), so handlers keep
  returning plain `gin.H{"error": ...}`. It's forwarded on the collab squash/flush calls; the
  WS server sends its own on the internal role lookup.
- **Logging is `log/slog`.** `NewLogger` (JSON in release/test, text in debug) is
  installed by `main.go` with `slog.SetDefault`, which also captures the `log` package.
  In handlers use `server.requestLog(c).Warn(...)` (adds the request id). Don't use
  `fmt.Printf`/`log.Printf`.
- **Never log** headers, cookies, tokens, tickets, passwords/hashes, request bodies,
  raw paths or query strings, usernames, or (outside debug) IPs/user agents. Log users
  by `user_id` and routes by `c.FullPath()`. `NewLogger`'s `redactSensitiveAttr` blanks
  attributes whose key contains authorization/cookie/password/secret/token/ticket/hash,
  as a backstop only.
- **Health:** `/health` + `/api/v1/health` = liveness; `/readyz` = readiness
  (`db.Store.Ping`, 2s timeout, 503 when down). Compose healthchecks use `/readyz`.
  Tests mock it with `store.EXPECT().Ping(...)`.
- **Recovery** treats a broken pipe / connection reset (client hung up) as a warning
  (`client_disconnected`), not a reported 500.
- Session security events (`logSecurityEvent(c, ...)`) carry the request id.
- **Metrics:** `metrics.go`, hand-rolled Prometheus text at `GET /metrics` on the
  **internal** listener (unauthenticated; the unpublished port is the restriction).
  Labels are bounded: route template or `(unmatched)`, unknown methods → `OTHER`.
- **Error tracking:** `ErrorReporter` (`SetErrorReporter`, no-op default) gets
  recovered panics (with stack) and 5xx responses, once each.

## Gotchas

- **Themes are discovered from disk** on startup (`ScanThemesDirectory("web/themes")`,
  needs `theme.config.ts` + `layouts/{post,page}/default.astro`). The production image
  ships `web/themes` for that (`Dockerfile`, a `.dockerignore` exception); without it a
  fresh database has no themes.

- `block_doc` (jsonb on `posts`) is the **working copy** the editor loads;
  `published_block_doc` is the published snapshot the public frontend reads. They can
  diverge (a bug can wipe the working copy while the published one stays intact).
- **Revisions (#136)** are the Block Spec v1 rows publish writes to `post_versions`
  (not Yjs snapshots). `GET /posts/:id/versions[/:version_no]` and
  `POST /posts/:id/unpublish` are admin/editor only. Publishing sets
  `post_status='published'`; unpublish sets `draft` and NULLs `published_block_doc` /
  `published_version_id` (versions stay). `/public/posts/:id/blocks` and the SSR post
  page 404 unless the status is `published`. **There is no restore endpoint on
  purpose:** never write `block_doc` from the server while editors may be connected;
  the editor restores through Yjs and saves with the normal PUT (under hocuspocus the
  collab server's store persists it instead). The only server-side `block_doc` writer
  allowed is the collab server's `PUT /internal/posts/:id/collab`.
</content>
