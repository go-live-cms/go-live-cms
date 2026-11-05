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
`/api/v1` (+ a `/public` group for SSR). Auth via `server.requireAuth()`
(`authMiddleware` with the server's token maker, store and `LAST_ACTIVE_INTERVAL`); the
payload is under context key `authorization_payload` (`getAuthPayload(c)`).

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
The collab server never sees access tokens (#233). The editor exchanges its access
token for a **collab ticket** at `POST /collab/tickets` (`canReadPost` on the doc's post): v4.public, signed
with the access key, audience `golive.admin-ws`, `token_type: ws_ticket`, `doc` claim,
30s TTL (`token/ws_ticket.go`, `collab_*.go`). `VerifyToken` rejects tickets, so they're
not bearer tokens. The API never accepts a ticket back: the collab server verifies it
locally, burns its jti (single use, in the collab process), and asks the internal access
endpoint below whether the user may edit that doc (#223, #135). The ticket never leaves
the collab server.

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
    (`canCreatePost`). They may edit their own posts' **working copy** (a read-write
    collab connection: `canEditPost`) at any status but scheduled (#147), and watch live,
    read-only, the posts they may read (`canReadPost`).
  - The **live** fields (PUT `/posts/:id`, meta, featured image, media links, DELETE)
    only while their post isn't published (`canEditPostDetails`). Otherwise they could
    change or remove published content without the publish permission. For the same
    reason the collab store doesn't sync a published post's `post_media` (publish does),
    and PUT `/posts/:id` refuses a `post_status` change
    (403) from anyone who can't publish. A `post_parent` must be a post the caller can
    edit (`canEditPost`).
  - Publish/unpublish/revisions stay `requireContentEditor`.
  - **Edit access grants (#321):** a contributor granted access to someone else's post
    (`post_collaborators`) edits its working copy while it is published
    (`canEditWorkingCopy` = `canEditPost` + the grant; see "Edit access requests" below).
    Nothing else: `canEditPost` (parent rule), `canEditPostDetails`, `canReadPost` and the
    list filters stay ownership-based.
  - Per-post write routes use `requireContentAuthor` (any content role) plus, in the
    handler, `server.authorizePost(c, id, rule)` (skips the post lookup for moderators;
    404 for a missing post, 403 when refused). Use `server.checkPost` when the handler
    already loaded the post, and `authorizeLoadPost` to reuse the row it loads.
  - Never compare `post.UserID` or roles in a handler. Block-level permissions and
    org/site scoping are out of scope.
- **Reads are not public (#393).** Every `/api/v1/posts*` route serves the working copy
  (any status, working title/excerpt/meta), so every one takes `server.requireAuth()` +
  `requireContentAuthor`, as do `/media*`, `/users/:username`, `/posts/:id/taxonomy-terms`
  and `/posts/:id/taxonomies` (`/taxonomy/terms/:id/posts`: `requireContentEditor`).
  `canReadPost`: moderators any post, contributors their own (any status) and published
  ones. Per-post reads check it (`authorizePost`/`checkPost`, 403); lists, counts, search
  and `/posts/user/:id` pass `postsViewerID` as the queries' `viewer_id` (0 = all, else
  `user_id = viewer OR published`); "Used in" drops posts the caller can't read.
  Anonymous readers get `/public` only (published snapshots). `route_auth_test.go` walks
  the router: a GET outside `/public` must answer 401 without a token unless it is in
  `publicGETRoutes` with its reason (health, `/uploads`, settings, themes, post types,
  taxonomy config). `post_reads_auth_test.go` checks the roles and that `/public` never
  serves a draft, against the real database.
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
  transparent) in `<dir>/_variants/<file>/`, plus **`social`** (#357): a 1200 x 630 crop
  around the focal point (`socialCrop`, from the original; a smaller image gives a
  smaller 1.91:1 crop), regenerated when PUT sets the focal point
  (`restageMediaVariants`, through `SetMediaVariantsTx`). It's not the whole image, so
  block media (`resizedOnly`) and srcsets leave it out. The backfill's "missing" includes
  rows without a `social` key, so run `main backfill-variants` once after deploying #357.
  They're **staged** and only moved into place once the DB agrees (`stagedVariants.commit`), so a failed Replace keeps the
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
- **Missing alt text (#325, `000026`):** alt is optional on upload (no file-name fallback;
  bulk uploads store `""`), `PUT /media/:id` `alt: ""` clears it (absent keeps; name and
  description still treat `""` as keep), and `media.decorative` marks an image whose empty
  alt is intended. Missing = `mime_type LIKE 'image/%' AND NOT decorative AND alt !~ '\S'`,
  written in three queries that must agree: `ListMedia` (`missing_alt=true`, plus
  `published_post_count` per row), `CountMedia` (GET /media's `total`, now the filtered
  count) and `CountMissingAltMedia` (`GET /media/missing-alt`, content roles:
  `{media_count, published_post_count}`, published = `post_status`, via `post_media`).
  `BlockMedia.decorative` makes the public renderer emit `alt=""`.
- **Media usage (#176, `000028`):** `post_media` is one row per (post, media): `order` 0 =
  featured image, > 0 = content link, and `blocks` (jsonb `[{"id","type"}]`) = the content
  blocks showing it, in document order, for the order-0 row too. `SyncPostContentMedia`
  takes parallel `media_ids`/`block_ids`/`block_types` (`db.ContentMediaUse`, built by
  `BlockDocV1.contentMediaUses`; the Tx params' `ContentMedia`). Unsetting or replacing the
  featured image goes through `UnlinkPostFeaturedMedia`, which keeps an image that is also in
  the body as a content link. `GET /media/:id/posts` adds `usages` (`featured` | `block` |
  `attached`, `mediaUsages`). One row per pair keeps #325's counts unchanged.
- **`media_path` in responses is a URL path, not the stored value.** The DB holds
  the filesystem path (`<UPLOAD_PATH>/<file>`, e.g. `/app/uploads/media/x.jpg` in
  compose); responses map it to where `/uploads` serves it (`/uploads/media/x.jpg`)
  via `server.mediaResponse` / `publicMediaPath`. The admin uses it directly as the
  image URL, so never return a media row through bare `toMediaResponse`.
- **Stored names are unguessable (#399).** `/uploads` is a public static route (published
  pages embed it; no directory listing), so the file name is what keeps a draft-only image
  private. Every new file goes through `saveUploadedFile`: `<cleaned name>-<32 hex><ext>`
  (128 random bits, `O_EXCL`, a failed write leaves nothing), variants under that name.
  `original_filename` and the default `name`/description use the readable
  `cleanUploadFilename`, never the stored name. Replace keeps the path. Files from before
  #399 (dev/seed only: no deployment had uploads) keep their names: renaming would mean
  rewriting `src` inside `post_ydoc_state`, `block_doc`, versions and `_thumbnail_url`. Never
  write an upload under a name a client chose or can predict.
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
  set). A session blocked by logout or a password change just gets 401. Reuse logs a
  `refresh_token_reuse` warning with the reused session's id. Two refreshes racing
  with one token: one rotates; the other waits on the session row lock and gets 401
  (or, arriving after the commit, counts as reuse). Already-issued access tokens are
  not revoked by any of these (they live `ACCESS_TOKEN_DURATION`); only a password
  change cuts them short. `auth_flow_test.go` (#162) runs these flows against the
  real database; `BlockAllSessionsForUser` uses the partial index `000029` (#160).

## Tests

- `go test ./...` (or `make test`). Handler tests use `MockStore`; `db/sqlc/*_test.go`
  run against a real Postgres test DB.
- CI (`.github/workflows/ci.yml`) runs the Go suite with a Postgres service via
  `make coverage-check`, which fails if total coverage drops below `COVERAGE_MIN`
  in the Makefile. Raise the floor when coverage goes up; never lower it to pass.
- sqlc integration tests share one DB across runs and are not cleaned up: use
  unique values (UUID/UnixNano suffixes) and restore global state such as the
  active theme with `t.Cleanup`.

## Collaboration server (#206, #280)

The Hocuspocus collab server (`web/collab-server/`) is the only collaboration backend and
the **only writer of `block_doc`** for an existing post. Until P5 (#285) a
`COLLAB_BACKEND` flag also allowed the old y-websocket server, whose clients autosaved
through `PUT /posts/:id/blocks` and whose LevelDB was squashed after a publish; the flag,
that route and the squash call are gone. `NewServer` requires `COLLAB_INTERNAL_URL` +
`COLLAB_INTERNAL_SECRET` (handler tests get a fake collab server that answers 200 from
`newTestConfig`; `newCollabTestServer` points at your own). History and the guards:
`docs/operations/collab-cutover.md`.

- **API → collab calls** (`collab_internal_client.go`: the publish flush, and the
  best-effort user re-check of #333) use `COLLAB_INTERNAL_URL` +
  `COLLAB_INTERNAL_SECRET` (Bearer). `NewServer` trims both (URL also of trailing `/`)
  and refuses to start without them. The secret is NOT the one the collab server sends to
  the API (that's `ROLE_LOOKUP_SECRET`). **Before** reading `block_doc`, publish calls
  `POST /internal/documents/post-<id>/flush` synchronously (`collabFlushTimeout`, 5s).
  200 = stored or not loaded. Anything else (down, timeout, non-200) → **503**, nothing
  published, so a snapshot never misses the last debounced edits.
- **Collab → API** (internal listener, `ROLE_LOOKUP_SECRET`, `internal_handlers_collab.go`):
  - `GET /internal/posts/:id/collab` → `{block_doc, block_revision, ydoc_state?, epoch?}`
    (`ydoc_state` base64). **Revision guard is applied here:** the state is returned only
    if `post_ydoc_state.block_revision == posts.block_revision`; otherwise something wrote
    `block_doc` around the collab server and the state is omitted, so the server reseeds
    under a new epoch.
  - `PUT /internal/posts/:id/collab {state, epoch, block_doc?, last_editor_id?, base_revision?}`
    → `{block_revision, epoch}`. 16 MiB body (`collabStoreBodyLimit`), `block_doc` itself
    ≤ 4 MiB, and `prepareForStore` (limits, dedupe `blocks_order`, sanitize, v1 + order
    integrity). `block_doc` omitted/null = store the Yjs state only (server-side
    validation failed), revision unchanged; that **requires `base_revision`** (400
    otherwise), or a stale state could be stamped with the current revision and pass the
    guard. `base_revision` behind → 409. 404 for a missing post.
  - `StorePostCollabTx` (`db/sqlc/post_collab_tx.go`) is one transaction: lock the post,
    `block_doc` + `block_revision+1` + `changed_at` (state-only stores touch none of
    them, #307), sync content media links (`SyncPostContentMedia`:
    unknown media ids skipped, featured image's order untouched; **only while unpublished**,
    publish syncs them otherwise), upsert `post_ydoc_state` (`000020`) at the new revision with
    `last_editor_id` (NULL if the user is gone).
- **`GET /posts/:id/blocks`** (`canReadPost`) and `/versions[/:no]` stay: the static
  read-only view and revisions use them. A stored `{}` comes back as a well-formed empty
  doc (`parseStoredBlockDoc`, #304). There is no write route for the working copy.
- **`POST /posts` takes an optional `block_doc`** (#283): the new post's initial body, with
  the same `prepareForStore` checks and the 4 MiB body limit. The collab server seeds the
  doc from it on first open. Nothing is live yet, so this isn't a write around the collab
  server.
- **`POST /posts/:id/duplicate`** (#354, `posts_duplicate.go`) is the other new-post writer:
  a draft owned by the caller (any content role: read access + `canCreatePost`), title
  "<title> (copy)", slug `<slug>-copy` made unique, same type/description/terms/featured
  image, parent kept only if the caller may nest under it (`mayNestUnder`, else top-level),
  and the source's working copy, read after a collab flush like publish (503 if it fails),
  with **every block id regenerated** (`regenerateBlockIDs`: keys, `id`,
  `blocks_order`, `children`, every `data-block-id` in `pm`). Never versions, comments,
  other meta or `post_ydoc_state`: the collab server seeds the copy from `block_doc`.
  The writes are one transaction (`DuplicatePostTx`); `newPostCopy` is the reusable part
  (shared with templates, #322, below). `duplicatePost.vectors.json` (web) is shared with
  the collab tests.
- **`POST /post-templates/:id/posts`** (#322) is the third: a post made from a template,
  built by the same `newPostCopy` (fresh block ids, unique slug and url) and seeded by the
  collab server like any new post. See "Post templates" below.
- **Tickets:** `POST /collab/tickets` uses `canReadPost` (moderators any post, contributors
  their own and published ones, #393): contributors get a read-only live view of others'
  published posts, never their drafts. The ticket
  carries no role; the server asks `/internal/users/:id/access` and makes `can_edit:
  false` connections read-only.

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

## Users screen: last active, search, role change, removal (#333)

- **Last active** (`users.last_active_at`, `000032`): `authMiddleware` stamps it when the
  row it already loaded is at least `LAST_ACTIVE_INTERVAL` old (default `5m`; **0 = off,
  so a zero `Config` (tests) never writes it**), and so do `startSession` (login, accept,
  self password change) and refresh rotation, after the commit. `TouchUserLastActive` re-checks
  the age in SQL, so a burst of requests writes once, and skips a locked row (`FOR UPDATE SKIP
  LOCKED`: a role change locks every admin) instead of making the request wait. A failed write is logged
  (`last_active_update_failed`) and never fails the request. Tests that want it set the
  interval (`newRateLimitedTestServer`).
- **`GET /users`** (admin) is `ListMembers` + `CountMembers`: `?q=` (name, username or
  email; ILIKE substring, wildcards escaped by `memberSearchPattern`, ≤100), `?role=`, the
  old sorts, and per row `last_active_at` (null = none) and `posts_owned` (`posts.user_id`,
  every type and status) in the same query. `meta.total` is the filtered count.
- **`PUT /users/:id/role {role}`** (admin) → `ChangeUserRoleTx`; `PUT /users/:id` with a
  role still works. Both refuse the last admin (409, `code: last_admin`), the caller
  included: `guardLastAdmin` locks every admin row inside the transaction, so two
  concurrent demotions of the last two admins can't both pass (tested against the DB).
- **Role changes apply at once.** The API reads the role from the DB on every request, so
  a demoted member's access tokens lose the rights at once (the token's `role` is
  informational, and refresh tokens carry none). For open documents the API then calls the
  collab server's `POST /internal/users/:id/recheck` (`recheckCollabUser`, after the
  commit, in the background, best effort): it re-checks their connections now instead of
  at the next `COLLAB_ACCESS_RECHECK_MS` (#313), so an editor demoted to contributor drops
  to read-only on someone else's post. If that call fails the periodic re-check still
  catches it.
- **`DELETE /users/:id {transfer_to_id}`** (admin; the body is required) →
  `RemoveUserTx`, one transaction. **Removal is a hard delete** of the user row, so the
  username and email can be invited again and nothing has to filter "deleted" users:
  - refused for the last admin (409 `last_admin`), for yourself (409
    `cannot_remove_self`), and for a recipient that is the member or doesn't exist (400
    `invalid_transfer_target`);
  - the member and the recipient are locked in id order (`LockUsersForUpdate`); every post
    they own moves to the recipient (`user_id` and the denormalized `username`), with
    their byline (`user_posts`, #319) on those posts unless the recipient is already
    credited; their media move too (`media.user_id` has no ON DELETE);
  - **bylines (#319):** the credit can't be kept (the row is deleted), so on posts they
    owned the recipient takes their place, on other people's posts it is dropped, and a
    byline left empty credits the post's owner. The **published** bylines
    (`published_settings.author_ids`, `ReassignPublishedBylines`) get the same rule at
    once, not on the next Update, so no post gains a pending change;
  - their sessions are deleted, which revokes every refresh token; a still-valid access
    token gets 403 at once (no user row); their open collab connections close on the
    re-check above;
  - what goes with the row: reset tokens (CASCADE). What stays without them: revisions they published
    (`post_versions.created_by` → NULL, `000032`; it had no ON DELETE, so removing anyone
    who had published used to fail), invitations they sent (`invited_by` → NULL; still
    valid, revocable from the list), `post_ydoc_state.last_editor_id` (NULL).
  - The old no-transfer delete (`DeleteUserTx`), which deleted the member's posts and media
    rows, is gone.

## Invitations, password reset, mail (#148)

- **Invite-only by default.** Admins create invitations (`/invitations`, `invitations_handlers_{read,write}.go`);
  `POST /auth/invitations/accept` creates the user with the invitation's email and
  role. Open signup (#191, below) is off unless an admin turns it on.
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

## Open signup (#191, `000039`, `signup_handlers_write.go`)

- **Off by default:** `settings.allow_signup` (Settings › Accounts; `PUT /settings`, admin only;
  public in `GET /settings`, the sign-in page reads it). The first admin is still created with
  SQL (deploy.md step 5). Off: `POST /auth/register` and `/auth/register/verify` answer **403
  `signup_disabled`**, not the unknown-route 404 (the setting is public, so a 404 hides nothing;
  the code lets the pages say so). Turning it off also ends links already sent.
- `POST /auth/register {username, full_name, email, password}` (`RegisterRequest`: accept-invite's
  rules + email, `new_password` + `checkPasswordDetails`, `checkUsernameFormat`) → **202, the same
  body for any address**. The lookup, bcrypt, token and email run after the response
  (`runInBackground` → `processSignup`), so timing doesn't tell either. A taken address gets a note
  to its owner (`signup_existing` template, a forgot-password link) and nothing is stored. The
  check ignores case (`GetUserByEmailFold`): the SQL-created first admin may have capitals.
- **No user row until the link is used:** `signup_requests` (hash-only token, 24 h, bcrypt hash;
  email and username aren't unique there). `RequestSignupTx` deletes the address's earlier request
  and every expired row (so does `RunSignupRequestPrune`, hourly, main.go); `ConfirmSignupTx` claims
  it (`ClaimSignupRequest` DELETEs the row: single use), creates the user as
  `db.SignupRole` (**contributor, fixed**: editor publishes, never admin; the request can't name a
  role), deletes the address's rows. 409 `email_registered` / `username_unavailable` if taken
  since. Link: `PUBLIC_BASE_URL/verify-email#token=`; the page confirms on its button.
- **Username conflicts can't be hidden:** a taken username is a generic 409 `username_unavailable`
  before the response (the person must choose another; usernames show in bylines). It says
  nothing about the email.
- **Limits:** `register` per IP (middleware), `registerEmail` per IP+address after binding
  (`RATE_LIMIT_PASSWORD_FORGOT_PER_MINUTE`, visible 429; never the address alone, or anyone could
  lock its owner out), and
  `signupMail`, a silent one-email-a-minute cooldown per address (`allowSilently`) in the
  background (it also drops a corrected re-signup within the minute). Verify is an `accountToken`
  endpoint. No CAPTCHA. The password is chosen before verifying, so the email says to confirm only
  if you signed up yourself.
- Activity: `signed_up` (actor = the new member, `{role}`) on confirmation, never on the request.
- Tests: `signup_test.go` (mock: off, validation, no enumeration incl. the pre-response calls,
  limits, settings) and `signup_flow_test.go` (real DB: no sign-in before confirming, single use,
  expiry, replaced links, conflicts, closing signup, cleanup).

## Request validation and hardening (#139)

- **Bind JSON with `bindJSON(c, &req)`** (`request_binding.go`), never `ShouldBindJSON`.
  It rejects unknown fields and trailing data, and writes every error as
  `{"error": "<field> <message>", "fields": {"<json name>": "<message>"}}` without Go
  struct names or types. Use `bindOptionalJSON` when the body may be omitted, and
  `respondBindError` for a multipart `ShouldBind` error. A field a known client sends
  but the API ignores must be declared (e.g. posts' `content`), or that client breaks.
- Custom validator tags: `slug`, `identifier` (post type names; never a path),
  `setting_key` (meta/setting keys), `max_bytes=N` (passwords: bcrypt reads 72 bytes),
  `new_password` (at least `MinPasswordLength`, 12, #329).
- **New passwords** (`password_utils.go`): every binding that sets one uses
  `new_password,max_bytes=72`, never `min=N`, and the handler calls
  `checkPasswordDetails` (not the email, username or full name, case-insensitive; the
  update also checks the details the same request sets). Reset and accept read the
  token's user/invitation first for that (the Tx re-checks the token). Login keeps
  `min=6`, so passwords set before #329 still work. The web's `PASSWORD_MIN` is checked
  against the constant by `passwordRules.test.ts`.
  URLs use `http_url` (http/https only). Give every string a `max`.
- **Body limits** (`request_limits.go`): 1 MiB default on `/api/v1` and `/public`, 4 MiB
  for `POST /posts` (it may carry a `block_doc`), uploads exempt (they cap themselves). The internal listener
  has no group limit; `PUT /internal/posts/:id/collab` caps itself (16 MiB). A new upload route
  must be added to `bodyLimitOverrides` with 0. Block docs also get
  `checkLimits` (block count, block id length, JSON depth).
- **CORS:** `CORS_ALLOWED_ORIGINS` entries must be exact http(s) origins (no `*`, path
  or trailing slash), checked in `setupRoutes`. They are the admin's origins and get
  credentials; the public site renders server-side and needs no CORS.
- **CSRF:** `cookieOriginGuard` (`origin_guard.go`) on login/refresh/logout refuses
  cross-origin browser requests (Sec-Fetch-Site, else Origin vs Host /
  trusted-proxy X-Forwarded-Host), on top of SameSite=Strict + `__Host-`.
- **Key rotation (#158):** `PASETO_V4_PREVIOUS_{PUBLIC,LOCAL}_KEYS` (`<kid>=<hex>,…`) +
  `PASETO_PREVIOUS_KEYS_VALID_UNTIL` keep retired keys verifying until the cutoff
  (`token/paseto_v4_rotation.go`, `docs/operations/key-rotation.md`). Verification picks
  the key **by the footer KID** (current KID → current key, listed KID → that key), never by
  trying keys; signing only ever uses the current keys. A previous KID equal to the current
  one is a startup error. The old single-key `*_KEY_HEX` names are refused by `LoadConfig`
  (`renamedConfigKeys`).
- **Secrets from files (#158):** every secret setting also reads `<NAME>_FILE`
  (`secretFileSettings` in `util/config.go`: PASETO keys and lists, `ROLE_LOOKUP_SECRET`,
  `COLLAB_INTERNAL_SECRET`, `SMTP_PASS`, `DB_SOURCE`), trimmed; both set → error, and
  errors never include the contents. Add a new secret there. Prod `compose.yaml` passes the
  private/local keys and both shared secrets as compose secrets (`/run/secrets`);
  `check-env.sh` reads the top-level `secrets:` block.

## Rate limiting and client IP (#190, #156)

- `ratelimit.go`: a general per-IP limit on the `/api/v1` and `/public` groups, plus
  stricter per-IP limits on `/auth/register` (plus per email, #191) and `/auth/refresh`. Login has a per-IP
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

## Collaboration integration (access lookup, #223, #135)

- `GET /internal/users/:id/access?doc=post-<id>&issued_at=<unix>` (`internal_routes.go`,
  `internal_handlers_read.go`) is the collab server's per-connection check. It answers
  `{role, can_edit}`, where `can_edit` is `canEditWorkingCopy` for that post (ownership, or
  an edit access grant, #321). 404 if the user, or for a contributor the post, is gone; 403 when a
  contributor may not read it (`canReadPost`, #393: e.g. unpublished since the ticket; the
  collab server's timed recheck then closes the connection). It replaced
  the role-only `/internal/users/:id/role`; Hocuspocus's `onAuthenticate` (#206) calls it.
- **It is on a separate listener, not under `/api/v1`.** `newInternalRouter` builds its
  own Gin engine and `main.go` serves it with `StartInternal(INTERNAL_SERVER_ADDRESS)`
  (default `0.0.0.0:8081`). Never publish that port (compose doesn't). The public
  router answers 404 for `/internal/*` and `/api/v1/internal/*` (tested). Put any new
  server-to-server route there, not on `v1`.
- It is
  authenticated with `Authorization: Bearer <ROLE_LOOKUP_SECRET>` (constant-time
  compare), **not** `authMiddleware`, so it works with collab-only tickets
  (`golive.admin-ws`, `token_type: ws_ticket`, #233). The collab server passes the
  ticket's `user_id`, `iat` and `doc`. It reads the role (and owner) from the DB and
  refuses (403) tickets issued before the user's latest password change.
- `ROLE_LOOKUP_SECRET` is **required**: `NewServer` errors without it. It has no
  default, so `LoadConfig` binds it with `viper.BindEnv`. Without that, viper's
  `Unmarshal` drops env-only keys it doesn't know (see `util/config_test.go`).
  `NewServer` trims it once, and the collab server trims its copy too, so stray whitespace
  in `app.env` can't make the two sides disagree.

## Observability (#142, #155)

- **Middleware order** (both routers): `requestIDMiddleware` → `requestLogger` →
  `recoveryMiddleware`, before security headers/CORS, so preflights, 429s and panics
  are logged and carry `X-Request-ID`. `gin.Default()`/`gin.Logger()` are not used.
- **Request id:** a well-formed incoming `X-Request-ID` (`[A-Za-z0-9._:-]{8,128}`) is
  kept only from a peer in `TRUSTED_PROXIES` (public router) or on the internal
  listener; anything else gets a UUID, so clients can't choose their ids. Read it with `requestIDFromContext(c)`. `requestIDErrorWriter`
  splices `"request_id"` into every JSON error body (status ≥ 400), so handlers keep
  returning plain `gin.H{"error": ...}`. It's forwarded on the collab flush call; the
  collab server sends its own on its internal calls.
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

## Navigation menus (#347)

- `menus` (name, `location` unique when set) and `menu_items` (`000022`): `item_type`
  post | term | archive | custom, one target column each (CHECK), `parent_id` one level
  deep, `sort_order` = position in the whole menu in reading order. Target FKs cascade on
  delete; `parent_id` is SET NULL, so a deleted parent's children move up in place.
- **URLs are never stored for content items:** `ListMenuItemsWithTargets` joins the
  targets and `resolveMenuItem` (`menus_utils.go`) builds the URL at read time (posts by
  `menuPostPath`, the web's `postPath` rule; terms `/{taxonomy}/{slug}`, #348's route;
  archives `/{post_type}`), so links follow slug changes. Hidden from readers: unpublished
  posts, non-public or inactive types, non-public taxonomies, and any custom URL that
  fails `validMenuURL` (http(s) with a host, or `/path`; never `javascript:`, `//host`).
- Admin CRUD under `/menus` (`requireContentEditor`); `PUT /menus/:id/items` replaces the
  whole tree (`ReplaceMenuItemsTx`, locks the menu row). Assigning a location moves it
  (`SaveMenuTx` clears the old holder). Public: `GET /public/menus/:location`, visible
  items only, 404 when nothing is assigned. Themes declare `menuLocations` in
  `theme.config.ts`; the scanner stores them as `config.menu_locations`.

## Public author pages (#350)

- `users.bio` (plain text, ≤300 characters) and `users.website` (http/https URL), `''` =
  unset. `PUT /users/:id` takes them as optional pointers: absent keeps, `""` clears
  (`normalizeBio`/`normalizeWebsite` in `users_utils.go`; `UpdateUser` uses `sqlc.narg`, so a
  NULL keeps the stored value).
- `/public/authors[/:username[/posts]]` and `/public/posts/:id/authors`
  (`authors_handlers_read.go`) answer with `AuthorProfileResponse` only, never
  `PublicUserResponse` (it has the role and id) or a `db.User`. Who has a page is decided
  in `db/query/authors.sql` alone: credited in the **published** byline
  (`post_published_authors`, #319) of a `published` post of a public, active type, so a byline
  edit gives or takes a page on Update. Anyone else gets the same 404 body as an unknown username (tested),
  so the routes can't enumerate accounts.

## Byline authors (#319, `000034`, `posts_authors.go`)

- **The owner (`posts.user_id`) decides access; the byline only credits.** `user_posts`
  (post_id, user_id, `order`) is the working byline: one or more users in order, never
  empty (000034 credited the owner where a post had none; removal keeps it so). Being
  credited gives no access (`canReadPost`/`canEditPost` read the owner only), and no
  byline edit changes the owner. A new post's byline is its `author_ids` (a contributor:
  only themselves), a duplicate's the caller.
- `GET /posts/:id/authors` (`canReadPost`), `PUT /posts/:id/authors {author_ids}` (1-20
  distinct existing users, in order; `canEditPostByline` = `canEditPostDetails`: moderators
  any post, a contributor their own unpublished one, crediting anyone) →
  `SetPostAuthorsTx` (users `FOR KEY SHARE` **before** the post lock, RemoveUserTx's order, so the
  two can't deadlock; unknown user 400). Optional `base_author_ids` = the byline the client
  edited: if it changed meanwhile, 409 `byline_changed` with the current `authors` and nothing
  written (the admin always sends it, so two editors can't drop each other's credit). `GET
  /posts/author-candidates?q=` lists `contentRoles` members (`auth_roles.go`) for the picker (id,
  username, full name; GET /users is admin-only, so contributors can list members' names here).
- **It's a post setting:** `golive_post_settings()` has `author_ids`, so a byline edit on a
  published post waits for Update (#326's flag sees it), versions record it, and
  restore-settings brings it back (users removed since skipped; none left or a version
  without `author_ids` keeps the working byline). `post_published_authors` mirrors
  `published_settings.author_ids` (trigger, like `post_published_terms`; never write it).
- **Public reads use the published byline only:** `golive_post_published_byline()` in the
  `/public` lists (`ListPostsWithMeta` with `published_byline`, adjacent/related, term and
  author lists), `/public/posts/:id/authors` and who has an author page. The admin lists use
  `golive_post_byline()` (`user_posts`). A post published without a snapshot credits nobody
  publicly (the theme shows its owner, unlinked).

## Post ownership: transfer (#353, `posts_owner.go`, `db/sqlc/post_owner_tx.go`)

- `POST /posts/:id/transfer {user_id, replace_in_byline?}` is **admins only**
  (`requireSiteAdmin`; editors can't, the issue's default). The new owner must be an
  **active member**: an existing user (removal is a hard delete, #333) with a content role
  (`contentRoles`), else 400 `invalid_owner`. 409 `already_owner`, 409 `post_trashed`
  (nobody edits a trashed post), 404 missing post. 200 `{post, owner, previous_owner_id,
  authors, byline_changed}`. `GET /posts/:id/owner` (`canReadPost`) → `{owner}` (public
  fields), for the settings panel's Owner field.
- `TransferPostOwnerTx`: new owner `FOR KEY SHARE` (`LockNewPostOwner`), then the post `FOR
  UPDATE` (`LockPostOwner`), users before posts like `RemoveUserTx`/`SetPostAuthorsTx`.
  **`reassignPostOwner` is the one reassignment** for both a transfer (one post) and a
  removal (`AllPosts`): `user_id` + `username`, and with `ReplaceInByline` the old owner's
  place in the **working** byline goes to the new owner in place (or their credit is dropped
  where the new owner is already credited). A transfer never touches
  `published_settings`: on a published post a byline change waits for Update (#319); an
  owner change alone is no pending change. `changed_at` moves only when the byline changed.
- After the commit: `recheckCollabDoc` (the #313 re-check on that document), so a
  contributor who lost the post drops to read-only at once (and one who received it gets
  write); activity `transferred` with `previous_owner_id`, `owner_id`, `byline_changed`. A
  removal now also re-checks the recipient (`recheckCollabUser`) when posts moved, and
  applies the same active-member rule to its recipient (`RemoveUserTxParams.OwnerRoles` =
  `contentRoles`, else 400 `invalid_transfer_target`).
- Tests: `post_owner_test.go` (real DB: byline kept/replaced, published byline waits,
  refusals incl. a removed member, removal and transfer give the same result) and
  `posts_owner_test.go` (roles, codes, the re-check, the event).

## Profile: avatar, email change, other devices (#334)

- **Avatar** (`avatar_utils.go`, `avatar_handlers_write.go`): `PUT /users/me/avatar` (multipart
  `file`, optional `focal_x`/`focal_y` 0..1 as displayed) and `DELETE`. A **dedicated upload,
  not a media item** (no library row editors could delete or reuse, no `post_media`). Sniffed
  JPEG/PNG/GIF/WebP only (DecodeConfig must agree), ≤5 MiB (`avatarMaxBytes`, body exempt in
  `bodyLimitOverrides`), ≤40 MP; a GIF's first frame. The API crops the largest square around
  the focal point (EXIF orientation applied), scales it to 256 px (never up) and re-encodes it
  (JPEG, PNG with transparency), so no metadata survives. Stored in `<UPLOAD_PATH>/_avatars/`
  through `saveUploadedFile` (#399 names, backups include it). `users.avatar_url` (`000038`)
  holds the **`/uploads` URL path** (`''` = none), so bylines built in SQL return it as is:
  every user shape has `avatar` (URL or null): private/public user, `PostAuthorResponse`
  (`golive_post_byline`/`golive_post_published_byline`, redefined by 000038, and the Authors
  field's queries), `AuthorProfileResponse`. `SetUserAvatar` returns the
  previous URL under a row lock; its file is removed after the update (`removeAvatarFile`, only
  a name that parses as ours, `avatarFilePath`), and on member removal (`RemoveUserTxResult.AvatarURL`).
- **Email change** (`email_change_handlers_write.go`): `POST /users/me/email {current_password,
  new_email}` (the self password-change limit, per user+IP) → **202 with the same body whatever
  the address**; the lookup, token and email run after the response (`runInBackground`). A taken
  address gets no email and no token. Otherwise `RequestEmailChangeTx` ends earlier links and
  stores one (`email_change_tokens`: hash only, 24 h, single use); the link (`/confirm-email#token=`)
  goes to the **new** address. `POST /auth/email-change/confirm {token}` (public, account-token
  limit) → `ConfirmEmailChangeTx` (user row, then token rows, like resets): `invalid_token` (400)
  for unknown/expired/used/replaced, `email_taken` (409) if another account took it meanwhile;
  on success the email changes, other pending email links and **password reset links** are used
  up, and the old address gets a notice (new address masked, `mailer.MaskEmail`). Sessions are
  not revoked (the issue doesn't ask; the password is unchanged). A password change or reset ends
  pending email links. **`PUT /users/:id` refuses a self email change** (400
  `email_change_requires_confirmation`); an admin may still set someone else's.
- **Other devices** (`sessions_handlers_manage.go`): under `/auth` because they read the refresh
  cookie (the dev cookie's Path is `/api/v1/auth`) to know which session is this browser's.
  `GET /auth/sessions` → active sessions (not blocked, not expired; `ListActiveSessionsByUser`,
  index `000029`) with `current`, `last_used_at` (the row's `created_at`: rows rotate on refresh)
  and `other_count`; IPs only in debug (also blanked on the old `GET /sessions`).
  `POST /auth/sessions/sign-out-others` (`cookieOriginGuard`) → `SignOutOtherSessionsTx`: the user
  row `FOR UPDATE` (serializes with rotation, like a password change), the cookie's session must be
  an active one of theirs (else 409 `session_not_active`), then `BlockOtherSessionsForUser`. Other
  devices' access tokens live out `ACCESS_TOKEN_DURATION`, as after a logout.

## Public term archives (#348)

- `GET /public/taxonomies/:taxonomy/terms/:slug/posts?page=N` (`terms_public_handlers_read.go`)
  answers `{term, posts, pagination}` like `/public/posts/type/:type` (#349 helpers). Who has
  a page is decided in `db/query/terms_public.sql` alone: a term of a **public** taxonomy
  type. Unknown taxonomy, non-public taxonomy and unknown slug are the same 404 body.
- The list is published posts of public, active types tagged with the term **or any term
  below it** (recursive CTE over `parent_id`, `UNION` so a cycle still ends). Count and page
  use the same CTE, so `total` agrees with the rows. Page 1 of an empty term is a 200.
- `GET /public/terms?limit=&offset=` lists term pages with at least one post (theirs or a
  descendant's) and lastmod, for the sitemap.

## Full-text search (#145)

- `post_search` (`000024`): one row per post, `document` (tsvector: title A, description B,
  public taxonomies' term names B, published body C) and `body_text` (the published body as
  plain text, for excerpts). A published post is indexed by its **published** title,
  excerpt and terms (`published_settings`, #358; 000027), a draft by its working ones, so a
  settings edit on a published post reaches the public search on Update. The admin search
  (`SearchPostsWithMeta`) also matches a published post's working title and excerpt.
  **Triggers keep it current**, not handlers: posts insert, and updates of
  title/description/`published_version_id`/`published_block_doc`/`published_settings` (so
  publish and unpublish), term links added/removed (working and published), a term renamed,
  a taxonomy's `public` flipped. The body is read from the `post_versions` row publish points
  at (else `published_block_doc`), never `block_doc`: collab stores don't fire them.
  `golive_block_doc_text(jsonb)` extracts the text in reading order (`text`, `code`, caption
  runs, `cite`, children).
- The text search config is `golive_search_config()`: the site language's (#330, below).
- Queries (`db/query/post_search.sql`) use `websearch_to_tsquery`: any input is valid. Rank:
  `ts_rank` (weights), then newest. `GET /public/search?q=&type=all|post|page&page=`
  (published posts and pages of public, active types; counts per type; pagination.go) and
  `GET /posts/search` (admin list: content roles, the list's type/status/user_id filters).
- **Highlights:** `ts_headline` puts U+E000/U+E001 around matches (removed from the source
  first); `highlightHTML` escapes everything and turns only those into `<mark>`. Never
  return ts_headline output any other way.

## Site settings (#330)

- `settings` (singleton) gained `site_tagline` (≤160, one line, trimmed), `site_language`
  (BCP-47 from `siteLanguages`), `site_timezone` (IANA, `time.LoadLocation`; `time/tzdata` is
  embedded so the image needs no zoneinfo; `Local`/`""` refused), `date_format`
  (`month_day_year`|`day_month_year`|`iso`), `editor_markdown_shortcuts` and
  `editor_allowed_embeds` (`embedProviders`, ≤20, deduped; absent keeps, `[]` clears) (`000025`).
  Lists and validator tags (`site_language`, `time_zone`, `embed_provider`, `single_line`) live
  in `settings_utils.go`; the web copies are checked against it by its tests.
- GET `/settings` also returns `site_address` (`PUBLIC_BASE_URL`, read-only, `""` if unusable):
  the domain is deploy config (`docs/operations/deploy.md`, "Change the domain").
- **Search follows the language:** `golive_search_config_for(language)` (000025; each
  language of `siteLanguages` → `english`/`portuguese`/…, else `simple`, checked against the Go
  list by `TestSearchConfigMigrationMatchesLanguages`) backs `golive_search_config()`, and the
  `settings_search_language` trigger reindexes every post when a language change changes the
  configuration (en-US → en-GB doesn't), in the settings update's transaction.
- The sanitizer has no embed path yet: iframe/embed nodes are always dropped
  (`disallowedNodeTypes`). The embed block (#352) is what reads the allowlist.

## Scheduled publishing (#147)

- `000033`: `posts.publish_at` (UTC) + status `scheduled` (CHECK: scheduled ⇔ `publish_at` set),
  `publish_scheduled_by` (the version's `created_by`), and the retry state `publish_attempts`,
  `publish_next_attempt_at` (claim lease / next retry), `publish_failed_at`, `publish_error`
  (a reason code). `PUT /posts/:id/schedule` (`{"local":"2026-11-03T09:00"}` in the site's zone,
  or `{"publish_at": RFC 3339}`; future, ≤5 years) and `DELETE` (back to draft), both
  `requireContentEditor` (`posts_schedule.go`). Only a draft or a scheduled post (409 otherwise;
  a published post's update has its own route, #335 below). `siteLocalToUTC` refuses a time the
  clocks skip and takes the first of one that happens twice; the web's `lib/schedule.ts` mirrors it. POST/PUT `/posts`
  refuse `post_status: "scheduled"` (400) unless unchanged; any other status set through PUT
  clears the schedule (`UpdatePost`), and so does every publish (`SetPublishedVersionOnPost`).
- **Contributors:** their scheduled post is read-only to them (`canEditPost` false, so the
  collab re-check demotes them): the scheduler publishes the working copy unreviewed.
- **The scheduler** (`scheduled_publish.go`, `RunScheduledPublishing` from `main.go`,
  `SCHEDULED_PUBLISH_INTERVAL`, 30s, 0 = off) runs in every replica. `ClaimDueScheduledPosts`
  takes one due row `FOR UPDATE SKIP LOCKED` and stamps a 2-minute lease; the row lock is NOT
  held across the flush (the collab store locks the same row). Then the Publish button's path:
  `flushCollabDoc` → `PublishScheduledPostTx` (lock, check still scheduled under this claim's
  lease value = the fencing token, `publishLockedPost`, shared with `PublishPostTx`).
  `db.ErrScheduleChanged` = cancelled/rescheduled/published/reclaimed meanwhile, nothing written.
  A failure is recorded (`RecordScheduledPublishFailure`, backoff 30s → 10 min, forever) and
  shown by `GET /posts/:id` as `schedule_failure`. Each attempt logs with its own `request_id`
  (also sent on the flush). Shutdown: `main.go`'s SIGTERM context stops the loop after the
  attempt in flight (`Serve`/`ServeInternal` drain HTTP too). Tests: `scheduled_publish_test.go`
  (real DB: due-only, two replicas, fencing, flush failure, shutdown, routes, not public) and
  `posts_schedule_test.go`.

## Trash, list filters and bulk actions (#327, `000037`, `posts_trash.go`)

- **Trash is a status, `post_status = 'trash'`,** plus `deleted_at` and `trashed_from_status`
  (CHECK: all three together). A status on purpose: every public read already wants
  `published` and the scheduler `scheduled`, so a trashed post is off the site, the sitemap,
  feeds, search, term/author archives, related/adjacent posts and menus with no query change.
  Its published snapshot stays, so restoring a published post puts the same content back. A
  trashed scheduled post keeps `publish_at` (000037 relaxes 000033's CHECK for that). Admin
  lists: no `status` = every status **but** trash (`ListPosts*`, the counts' `CountFiltered*`,
  `SearchPostsWithMeta`, `/posts/user/:id`); `status=trash` is the Trash tab; `/posts/counts`
  has a `trash` count.
- `DELETE /posts/:id` **moves to the trash** (`TrashPost`, the old delete's rule
  `canTrashPost` = `canEditPostDetails`; 409 `post_trashed` if already there). `POST
  /posts/:id/restore` (`canRestorePost`: moderators, or a contributor's own post that wasn't
  published or scheduled) → `RestorePostFromTrash`: the old status, except a scheduled post
  whose time passed comes back a **draft** (never published at once). `DELETE
  /posts/:id/permanent` (`requireContentEditor`, trashed only, else 409 `not_in_trash`) →
  `DeleteTrashedPostTx` (status checked under the row lock), the old hard delete. No auto-empty. A pending scheduled update (#335) ends with the trash (its `posts_cancel_scheduled_update` trigger), so a restored post has none.
- **Nobody edits a trashed post:** `canEditPost` and `canEditPostDetails` are false for it,
  moderators included; `checkPost` answers 409 `post_trashed` (not 403) to a caller who may
  read it, and the write routes that don't load the post (media links, SEO, restore-settings)
  use `authorizeWritePost`, which reads it for moderators too. Duplicate answers 409, `PublishPostTx` returns `db.ErrPostTrashed` (409, checked under
  the lock), `UnpublishPost` skips it (404), `SchedulePost` already wanted draft/scheduled.
  The collab store still accepts a trashed post's last store (the edits before the trash).
- **Collab:** `/internal/users/:id/access` reads the post for **everyone** now and answers
  **410 `{code: "post_trashed"}`** for a trashed one (the collab server refuses or closes with
  `post-trashed`, not as a revoked session). After a trash the API calls the collab server's
  `POST /internal/documents/post-<id>/recheck` (`recheckCollabDoc`, background, best effort; the
  periodic re-check is the fallback).
- **Filters** on `GET /posts`, `/posts/type/:type` and `/posts/search`: `author_id` (credited in
  `user_posts`, not just the owner) and `terms=1,2` (linked to every one, working terms, ≤10),
  with status, sort and `viewer_id`. `GET /posts/authors?type=` lists who is credited on posts
  the caller may read (the Author filter's options; editors can't list `/users`).
  The filter reads the working byline (`user_posts`, #319).
- **Search** (`/posts/search`) also matches part of the title or slug (`title_pattern`, ILIKE,
  wildcards escaped with `memberSearchPattern`), ranked after every index match. The #145 index
  stays the main search; there is no second search endpoint.
- **`POST /posts/bulk {action: publish|trash|restore|delete, ids: [≤100]}`** (any content role):
  each post is checked exactly as its single route checks it (publish needs a moderator,
  per item) and runs the same code (`publishPostByID` = flush + `PublishPostTx`, shared with
  `publishPost`; `trashPostByID`, `restorePostByID`, `deletePostPermanentlyByID`). 200 with
  `{action, results: [{id, ok, post_status} | {id, ok: false, status, code, error}], succeeded,
  failed}`, duplicates once, in order. Codes: `forbidden`, `not_found`, `post_trashed`,
  `not_in_trash`, `collab_unavailable`, `failed`. "Change byline author" is not a bulk action yet (#319's `PUT /posts/:id/authors` is per post).
- Tests: `posts_trash_db_test.go` (real DB: hidden from every `/public` route and menus,
  scheduler and its fence, restore, permanent delete, the filters combined, counts, bulk with
  mixed permissions, the authors list) and `posts_trash_test.go`.
## Scheduled updates (#335, `000035`, `posts_scheduled_update.go`)

- A published post with changes not published (#326) schedules its **Update**: `PUT
  /posts/:id/scheduled-update` (same body as `/schedule`: `local` or `publish_at`, future, ≤5
  years) and `DELETE` ("Cancel update"), both `requireContentEditor`. 409 for a post that isn't
  published (`post_status` in the body), `code: no_unpublished_changes` when the live post already
  matches, `code: not_scheduled` on a DELETE with nothing pending; 503 when the collab flush fails.
- **The content is frozen when it's scheduled** (the issue and the "Scheduled update" design:
  "later changes aren't included; schedule again to include them"). The handler flushes the collab
  doc like publish, then `ScheduleUpdateTx` (lock the post, published, has changes) copies
  `block_doc` and `golive_post_settings(id)` into `post_scheduled_updates` (one row per post,
  `UpsertScheduledUpdateFromPost`). Scheduling again (Reschedule) takes a **new** snapshot and resets
  the retry state. The working copy stays editable by everyone who could edit it (contributors
  too: their later edits aren't in the update, so #147's read-only rule isn't needed).
- **The same scheduler applies it** (`applyDueScheduledUpdates` in `scheduled_publish.go`, every
  round after #147's publishes): `ClaimDueScheduledUpdates` (`FOR UPDATE SKIP LOCKED`, the 2-minute
  lease is the fencing token) → `PublishScheduledUpdateTx` (lock post, then the update under the
  claim; next version from the **snapshot**, credited to `scheduled_by`; `publishInsertedVersion`,
  the rest of `publishLockedPost`). No flush at the time: the working copy isn't read. A failure is
  `RecordScheduledUpdateFailure` (`update_failed`, #147's backoff) and `GET /posts/:id`'s
  `scheduled_update.failure`. A term deleted since the snapshot is dropped (the published-terms
  trigger only keeps existing terms); a deleted featured image stays in the published settings, as
  it does when an image is deleted after an ordinary publish.
- **What ends it:** the `posts_cancel_scheduled_update` trigger deletes the row when `post_status`
  or `published_version_id` changes: an **Update by hand** (newer than the snapshot; applying it
  later would roll the site back; `PublishPostTx` reports it as `cancelled_scheduled_update` on the
  publish response), the update itself, unpublish, archive, trash, any status change.
  Post deleted: CASCADE. **Restoring a version** writes the working copy only, so a pending update
  is unaffected (schedule again to include the restored content).
- Reads: `GET /posts/:id` / `slug/:slug` add `scheduled_update` (`update_at`, `scheduled_at` = when
  frozen, `scheduled_by`, `failure`) and `update_at`; so does `GET /posts/:id/settings` (null when
  none), which every open editor re-reads on collaborators' stores; `ListPosts`, `ListPostsWithMeta` and
  `SearchPostsWithMeta` select `su.update_at` (LEFT JOIN, so `ListPosts` sorts by `p.created_at`);
  the authors/terms queries select `NULL::timestamptz`. Public presenters clear `update_at` (and the
  public `/posts` list now clears `has_unpublished_changes` too, which it used to leak).
- Tests: `scheduled_update_test.go` (real DB: the frozen snapshot vs a later edit, public unchanged
  before the time, two replicas, fencing, failure + retry, the loop, routes and roles) and
  `posts_unpublished_changes_test.go` (the detail field, public presenters).

## Post templates (#322, `000043`, `post_templates.go`)

- **Storage (decision): their own table, `post_templates`** (+ `post_template_terms`), not
  posts with a template status. Every read of `posts` (admin lists, counts, search and its
  index triggers, every `/public` route, sitemap, feeds, menus, related/adjacent, term and
  author archives, "Used in", the activity feeds, the scheduler, the collab server; #394's
  map, and #327's trash filtering shows what a status costs) would have to leave a template
  status out, and every new query would have to remember to. A row in another table can't
  leak through any of them. No collab document either: a template is a snapshot.
- A template: `post_type` (FK `post_types.name`, cascades), `name` (3–120 characters, one
  line, unique per type case-insensitively → 409 `template_name_taken`), `block_doc`, and
  optionally the source's settings: `featured_media_id` (`ON DELETE SET NULL`) and its
  **category** terms (taxonomy `category`; tags describe one post, not a kind of post).
  `created_by` (`SET NULL` on removal).
- Routes: `GET /post-templates?type=` (any content role: the new-post chooser), `POST
  /post-templates {post_id, name, with_settings}`, `PUT /post-templates/:id {name}` and
  `DELETE` (admins and editors, `requireContentEditor`). Saving reads the post like
  duplicate: `canReadPost`, trashed → 409, **collab flush first** (503 on failure), then
  `parseStoredBlockDoc` + **`prepareForStore`** (sanitizer, limits, theme blocks #376; 400),
  `CreatePostTemplateTx` (featured image and category read inside it).
- **`POST /post-templates/:id/posts`** (any content role, `canCreatePost` for an own draft):
  `newPostCopy` with `Check: true` (the content goes through `prepareForStore` again: the
  installed theme blocks may have changed; 400 "no longer valid"), title = the template's
  name, slug from it, url `/<type>/<slug>`, owner and byline the caller, then
  `CreatePostFromTemplateTx` (terms, featured image as `setFeaturedImage` writes it, content
  media links). No Yjs state; activity `created` with `template_id`. Deleting a template
  leaves the posts made from it alone (nothing points back).
- **Saving a template shares its content with every content role** (decision): listing
  and using one don't check `canReadPost` on the post it came from, so an editor who saves
  an unpublished draft makes that content available to contributors. Saving is the
  editor's explicit act, and the Save dialog says so ("Everyone who writes posts can start
  from its content, contributors included").
- Tests: `post_templates_test.go` (handler matrix on the mock store, validation, theme
  blocks) and `post_templates_db_test.go` (real DB: saving changes no list, count, search or
  `/public` read; the post's content, ids, terms, featured image, byline; rename, delete).

## Activity log and Home's feeds (#324, `000036`, `activity*.go`)

- `activity` is **append-only**: actor (`actor_id`, NULL = the system or a member removed
  since: the FK is `ON DELETE SET NULL`, the only UPDATE its trigger allows), `verb`,
  `object_type` (post | media | user | invitation | settings) + `object_id` (no FK: a deleted
  object's events stay), `payload` (a JSON object ≤ 1 KiB, CHECK) and `created_at`. The
  vocabulary is `db/sqlc/activity.go`; a new feature adds its verb there.
- **Privacy:** ids plus non-personal details only (a role, `version_no`, setting *names*,
  `publish_at`, `mime_type`, counts). Never names, emails, titles, content, IPs or user agents:
  `ListActivity` joins the current names and titles at read time.
- **Writing:** `server.recordActivity` / `recordRequestActivity` / `recordPostActivity` /
  `recordMediaActivity`, called by the handler **after** the change succeeded (the writes are
  often several statements and most aren't one transaction, so an event never describes a
  rolled-back change). A failed insert logs `activity_record_failed` (verb + ids) and never
  fails the request. Recorded today: post created (also duplicate, `source_id`), `updated`
  (PUT `/posts/:id`, `/seo`, `/authors`, the featured image), `status_changed` (PUT `/posts/:id` setting
  another status: unthrottled), published (also by the scheduler, actor =
  `publish_scheduled_by`, `scheduled: true`), unpublished, scheduled, unscheduled,
  `update_scheduled`/`update_unscheduled` (#335; applying the update is "published" with
  `scheduled_update: true`, credited to its `scheduled_by`), deleted,
  `version_restored`, `transferred` (#353, owner ids); media uploaded (single, linked, bulk), replaced, deleted; invited,
  `invitation_revoked`, joined (actor = the new member), user created (POST `/users`),
  `role_changed` (both routes, `previous_role`; none when the role is unchanged:
  `ChangeUserRoleTx` returns `PreviousRole`), removed;
  `settings_updated` (`fields`). The trash (#327): `trashed` (`from_status`), `restored` (`post_status`) and permanent delete as `deleted`, recorded by the per-post helpers in `posts_trash.go` so the bulk actions log each post too (bulk publish logs `published`: `publishPostByID` records it for both routes). Extension settings aren't recorded yet.
- **Throttle:** high-volume events ("updated", and "edited" from the collab store) are at most
  one per member, verb and object per `activityEditWindow` (10 min, `CreateActivityThrottled`).
  The collab one is written **inside** `StorePostCollabTx` (`EditActivityWindow`, only stores
  that write `block_doc`, only with `last_editor_id`), under the post's row lock, so it's exact.
- **Reads** (content roles): `GET /activity?limit=&before=&post_id=` (newest first, paged by
  id, `next_before`). Visibility is in `ListActivity` alone: admins everything; editors every
  post and media event; contributors events on posts they own or that are published (as the
  post is now, `canReadPost`) and on their own media. Member, invitation and settings events are
  admin-only. `GET /home/continue-editing` (the caller's created/edited/updated/
  `version_restored`/`status_changed` events, readable posts only, never archived or trashed; being
  `post_ydoc_state.last_editor_id` only sharpens the time to `changed_at`, never adds a post:
  state-only stores, a post merely opened, record their sender too). `GET /home/needs-attention`: `failed_schedules` (contributors their own),
  `unpublished_changes` + `missing_alt` (editors and admins; `null` otherwise),
  `review_requests` (`[]`, the slot for #323).
- **Retention:** `ACTIVITY_RETENTION` (default 2160h = 90 days, 0 = keep everything);
  `RunActivityRetention` (main.go, every replica) prunes hourly in batches of 5000.
- Handler tests on a mock store get an in-memory recorder (`newActivityWriter` is swapped in
  `test_utils_test.go`; read it with `activityOf(t, server).verbs()`), so they don't expect the
  inserts. `activity_test.go` covers the write paths, visibility, feeds and retention against
  the real database.

## Edit access requests (#321, `000042`, `posts_access.go`)

- **Model: a per-post grant, not the byline** (the byline only credits, #319).
  `post_collaborators` (post, user, granted_by) is the grant; `post_access_requests` the
  requests (`pending` → `granted` | `declined`, one open per member and post: partial unique
  index; optional `message` ≤500 characters, never in the activity log). Both CASCADE with the
  post and the member.
- **Rules (`auth_posts.go`):** `canRequestPostAccess` = `canEditAsCollaborator`: a contributor
  on someone else's **published** post (what they may read; a grant never reveals a draft).
  `canReviewPostAccess`: moderators, or the post's contributor owner; nobody on a trashed post.
  `canEditWorkingCopy` (`workingCopyAccess`) = `canEditPost` or (`canEditAsCollaborator` and a
  grant row): the internal access lookup and `GET /posts/:id/access`. A grant on a post that was
  unpublished since rests (the member can't read it: the lookup answers 403) and applies again
  once it is published; scheduled posts aren't published, so #147's rule holds.
- **Routes** (content roles; the rule in the handler, `loadPostForAccess`: 403 without
  `canReadPost`): `GET /posts/:id/access` (`can_edit`, `collaborator`, `can_request`, the
  caller's latest `request`; reviewers also `pending` and `collaborators`), `POST
  /posts/:id/access-requests {message?}` (201; 409 `already_has_access` / `request_open` /
  `recently_declined` with `request_again_at`; 429), `POST
  /posts/:id/access-requests/:request_id/{grant,decline}` (`ReviewPostAccessRequestTx`: the
  UPDATE claims it, so two reviewers can't both answer; 409 `already_answered`; 404 for another
  post's request), `DELETE /posts/:id/collaborators/:user_id` (204; 404 `not_a_collaborator`).
- **Abuse limits:** `RATE_LIMIT_ACCESS_REQUEST_PER_MINUTE` (3, per member+IP), the open-request
  index, and `accessRequestCooldown` (24h after a decline, in `CreatePostAccessRequest`'s
  INSERT … WHERE NOT EXISTS: no row = refused).
- **Notify:** after the response, `notifyAccessReviewers` emails every admin and editor plus a
  contributor owner (`ListAccessRequestReviewers`, never the requester; template
  `access_request`, link `PUBLIC_BASE_URL/gl-admin/content/edit/<id>`). Home's
  `/home/needs-attention` has `access_requests` (`ListPendingAccessRequestsForReviewer`:
  `postsViewerID`, trashed posts left out).
- **Live:** after a grant or a revoke the API calls `recheckCollabUser` (#333), so the member's
  open connection goes read-write (`restored`) or read-only (`demoted`) at once; the periodic
  re-check (#313) is the fallback. The collab server needed no change.
- **Activity:** `access_requested` (actor = requester, `request_id`), `access_granted` /
  `access_declined` (`user_id`, `request_id`), `access_revoked` (`user_id`). `ListActivity`
  joins `payload.user_id` as `subject`, and shows a contributor someone else's published post's
  `access_*` events only when they are the actor or the subject.
- Tests: `posts_access_test.go` (real DB: the flow, permissions, cooldown, rate limit, the race,
  emails, Needs attention, feed visibility, the collab lookup) and `internal_test.go`.

## Theme blocks (#376)

- Themes' custom blocks (`theme:<slug>/<block>`) are declared in TypeScript, so the web
  build generates **`web/themes/blocks.manifest.json`** (type → version + attr specs;
  committed, regenerated with `npm run themes:manifest` in `web/`). The image ships it
  with `web/themes`. `NewServer` loads it (`LoadThemeBlockManifest`, outside test mode):
  missing → warning, theme attrs unvalidated; present but invalid → startup error.
  Rebuild the api image (with web and collab, same commit) when a theme block changes.
- `prepareForStore(server.themeBlocks)` (`applyThemeBlocks`, `theme_blocks.go`), after the
  generic sanitizer: for a type in the manifest, undeclared attrs are stripped (null =
  unset), `pm.attrs` is removed (declared attrs are canonical on the block), and an
  invalid value or a version that isn't a positive integer → **400**. A `theme:` type not
  in the manifest (removed theme), or a version newer than the manifest's (written by a
  newer build, e.g. before a rollback), is kept as is: refusing it would lose content or
  block every store of the post.
- The collab server applies the same rules first, so a valid edit is never refused here.
  `web/gl-admin/lib/blocks-spec/themeBlockVectors.json` holds the shared cases
  (`TestThemeBlockVectors` and the web's `themeBlocks.test.ts`). Handler tests get an
  empty manifest; set `server.themeBlocks` (`loadRepoThemeBlocks`) to test with the real one.

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
  the editor restores through Yjs and the collab server's store persists it. The only
  `block_doc` writer for an existing post is the collab server's
  `PUT /internal/posts/:id/collab`.
- **Settings snapshots (#358, `000027`, `post_settings.go`):** publish (`PublishPostTx`: lock,
  next version_no, `InsertPublishedVersionFromPost`, `SetPublishedVersionOnPost`, then the
  content image links with `SyncPostContentMedia`, which never moves the featured image's
  order-0 row (#389), in one transaction) stores `golive_post_settings(id)` in `post_versions.settings` and
  `posts.published_settings`: title, description, featured image (`_thumbnail_id`/`_url` meta),
  sorted `term_ids`, the SEO fields (#357, below) and `author_ids` (the byline, #319). The SQL
  function is the one definition of the shape. Unpublish NULLs it; a version from before
  #358 has NULL (the migration backfilled only current versions). `post_published_terms` is the
  published term set as rows, kept equal to `published_settings.term_ids` by a trigger (never
  write it by hand); term archives, related posts and `/public/terms` join it. **Every public
  read shows published settings:** `/public/posts[/:id|/slug/:slug]` (the post page, feeds),
  the `/public` lists (`applyPublishedSettings`, `toPublicPostWithMetaResponse`), search and
  menu titles. `/api/v1/posts*` stays the working copy (the admin). The **slug is not in the
  snapshot** on purpose: it changes at once, with its conflict check. Restoring: the editor
  restores the blocks (rule 9), then `POST /posts/:id/versions/:no/restore-settings`
  (`RestorePostSettingsTx`) writes the version's settings into the working copy only;
  `GET /posts/:id/settings` says whether they differ from the published ones.
- **Changes not published (#326, `000030`):** `has_unpublished_changes` = `post_status =
  'published'` and the working copy differs from what the site shows: the body
  (`posts.block_doc_hash` vs `published_block_hash`, stored generated md5 columns of the jsonb
  text, so no writer maintains them) or the settings (`golive_post_settings_changed`, the same
  comparison as above). One definition, `golive_post_has_unpublished_changes(...)`, used by
  `ListPosts*`, `SearchPostsWithMeta`, `CountFilteredPosts`, `CountPostsByStatus` (its
  `unpublished_changes` column → `/posts/counts`' `unpublished_changes`),
  `GetPostHasUnpublishedChanges` (GET `/posts/:id` and `/slug/:slug`, published posts only) and
  `GetPostSettingsState` (`blocks_changed`, `has_unpublished_changes`). `ListPostsWithMeta`
  computes it only with `with_unpublished_changes` (the public lists share the query and skip
  it). Content, not revisions: an edit undone before the next publish is no change.
  `unpublished_changes=true` filters `GET /posts`, `/posts/type/:type` and `/posts/search`.
  The JSON field is omitted when false, and the public
  presenters clear it (the authors/terms queries select `false` to keep the shared row type).

## Post SEO (#357, `000031`, `posts_seo.go`)

- Typed columns on `posts`: `seo_title`, `seo_description` (`''` = the post's title /
  excerpt), `social_image_id` (FK media, `ON DELETE SET NULL`; NULL = the featured image),
  `noindex`, `canonical_url` (`''` = its own URL). `golive_post_settings()` snapshots them,
  so an SEO edit on a published post waits for Update; 000031 gave older snapshots the
  defaults. `golive_post_settings_changed` (#326) ignores a published social image deleted since.
- `PUT /posts/:id/seo` replaces them all (`requireContentEditor`: contributors see them
  read-only, decision 7). Title ≤255 single line, description ≤500 (the admin's 60/160 are
  soft guides), `validCanonicalURL` (absolute http(s), host, no spaces/userinfo), the social
  image must exist and be an image (400 otherwise).
- The working values are `seo` on `PostResponse` (admin). `/public/posts/:id|slug` answer the
  **published** ones as `seo` (`resp.Post.SEO` is cleared there) with `image` resolved:
  social image, else featured image, as its `social` variant when it has one.
  `/public/posts` rows carry the published `noindex` for the sitemap (nothing else hides the
  post). Restore-settings restores them (`RestorePostSEO`).
- **The excerpt is optional** (`description`: `max=500`, no minimum; on PUT absent keeps,
  `""` clears).
</content>
