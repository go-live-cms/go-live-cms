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
- **Extension settings (#451):** `GET /extension-settings[/:key]` are public for the theme,
  so they answer theme rows only: `GetThemeExtensionSetting` and `ListThemeExtensionSettings`
  can't return a plugin's row, and `?extension_type=plugin` is an empty list. `PUT` refuses the
  plugin type and any key but `theme:<extension_id>:<name>` (`validThemeSettingKey`), `DELETE`
  answers 404 for a plugin's row. Don't serve a plugin's settings from these routes; they get
  their own admin-only ones (design: `docs/design/plugin-system.md` section 6).
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
  **Media blocks (#423):** video, audio and file blocks store only `mediaId` (plus `caption` /
  `label`), so their entries also carry `mime_type`, `file_size`, `name` and `filename` (the
  uploaded name, which a download is saved as), and their URL is that `media_path` (always
  `/uploads/...`; the sanitizer keeps no `src` on them: `sanitizePlayableAttrs`,
  `sanitizeFileAttrs`, allowlists). Ids the lookup didn't find are listed in **`media_missing`**
  (sorted): the media was deleted, and the renderer leaves those blocks out, the image's too. A
  failed lookup adds neither key, so an image still renders from its `src`.
- **Add from URL (#29, `media_import.go`):** `POST /media/import {urls}` (any content role,
  1-10 links of ≤ 2048 characters) downloads each file and stores it **like an upload**
  (copy only, never a hotlink): `saveUploadedFile` names, `prepareStoredImage`, no alt,
  description "Imported from <host>". It is the API's third outbound request on a user's behalf
  (with embeds and plugin webhooks), so treat it as SSRF surface: it dials through
  `outbound_http.go` (every connection, each redirect's too, refused unless public after DNS),
  http(s) only, no userinfo, ≤ 5 redirects (`checkImportRedirect`), 5s connect / 15s headers /
  60s per link, 64 KB headers, no proxy or cookies, a `Content-Length` over `MAX_UPLOAD_SIZE`
  refused and the body cut off one byte past it (nothing left behind). **The type is sniffed:**
  an allowed extension on the name (Content-Disposition, else the final URL's path) must match
  the content as for uploads; any other name gets the extension its bytes identify
  (`sniffedImportExtension`; plain text, DOCX and MKV need theirs). 200 `{results: [{url,
  status: added|failed, media | code+error}], meta}`, one per link in order (a repeated link
  shares one fetch); every failure is a fixed `importFailure` (code + message, never the URL or
  Go's error text, which holds it). Rate limit `RATE_LIMIT_MEDIA_IMPORT_PER_MINUTE` (6, per
  member+IP). Activity: `imported` per file, payload `{mime_type, host}` only. Tests reach a
  local `httptest` server through `newMediaImporter(allowAddress)`, a test-only allowance for
  that one address and port (`outboundTransportOptions.allowAddress`, never from config); every
  other address, a second local server included, gets the real policy.
- **Missing alt text (#325, `000026`):** alt is optional on upload (no file-name fallback;
  bulk uploads store `""`), `PUT /media/:id` `alt: ""` clears it (absent keeps; name and
  description still treat `""` as keep), and `media.decorative` marks an image whose empty
  alt is intended. Missing = `mime_type LIKE 'image/%' AND NOT decorative AND alt !~ '\S'`,
  written in three queries that must agree: `ListMedia` (`missing_alt=true`, plus
  `published_post_count` per row), `CountMedia` (GET /media's `total`, now the filtered
  count) and `CountMissingAltMedia` (`GET /media/missing-alt`, content roles:
  `{media_count, published_post_count}`, published = `post_status`, via `post_media`).
  `BlockMedia.decorative` makes the public renderer emit `alt=""`; `BlockMedia.alt` (#481, the library's trimmed alt,
  never for a decorative image) is the fallback for a block without its own.
- **Media usage (#176, `000028`):** `post_media` is one row per (post, media): `order` 0 =
  featured image, > 0 = content link, and `blocks` (jsonb `[{"id","type"}]`) = the content
  blocks showing it, in document order, for the order-0 row too. `SyncPostContentMedia`
  takes parallel `media_ids`/`block_ids`/`block_types` (`db.ContentMediaUse`, built by
  `BlockDocV1.contentMediaUses`: every media block, `mediaBlockTypes` = image, video, audio, file
  since #423, cover and media & text since #427; the Tx params' `ContentMedia`). Unsetting or replacing the
  featured image goes through `UnlinkPostFeaturedMedia`, which keeps an image that is also in
  the body as a content link. `GET /media/:id/posts` adds `usages` (`featured` | `block` |
  `attached`, `mediaUsages`). One row per pair keeps #325's counts unchanged.
- **Video captions (#507, `000059`, `media_captions.go`):** on the media item, not the block:
  `media.captions_media_id` (FK media, `ON DELETE SET NULL`; never itself) is a `text/vtt` item and
  `captions_lang` its BCP-47 tag (`''` without captions). `.vtt` uploads are sniffed by `isWebVTT`
  (`WEBVTT` after an optional BOM, then space/tab/line break, and text: HTML is refused); `/uploads`
  serves them as `text/vtt; charset=utf-8` (`mime.AddExtensionType` in `media_captions.go`'s `init`;
  nosniff is global), and so does the web's production proxy. A response shows no `captions_lang`
  without captions (`captionsLangOf`: ON DELETE SET NULL leaves it), and new captions after a deleted
  file get the site language. `PUT /media/:id {captions_media_id: id|null,
  captions_lang}` (in `UpdateMediaMetadata`, `set_captions`): only on a `video/*` (400
  `captions_not_video`), only a `text/vtt` item (400 `invalid_captions`, also for a file deleted
  meanwhile), no language = keep the stored one, else the site language; a language alone needs
  captions. Responses carry `captions_media_id`/`captions_lang`. `attachBlockMedia` gives a video a
  **video block** shows `captions: {url, lang, label}` (label = the file's name, else the language;
  a second `GetMediaByIDs`, best effort). "Used in" of a captions file = `GetPostsByCaptionsMedia`
  (posts whose video blocks show a video it captions; usage `captions`). PUT/replace/DELETE media
  already purge the public cache.
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
  published, so a snapshot never misses the last debounced edits. The version restore
  (#286, `restoreCollabVersion`) calls `POST /internal/documents/post-<id>/restore`
  synchronously too (Revisions, below).
- **Collab → API** (internal listener, `ROLE_LOOKUP_SECRET`, `internal_handlers_collab.go`):
  - `GET /internal/posts/:id/collab` → `{block_doc, block_revision, ydoc_state?, epoch?}`
    (`ydoc_state` base64). **Revision guard is applied here:** the state is returned only
    if `post_ydoc_state.block_revision == posts.block_revision`; otherwise something wrote
    `block_doc` around the collab server and the state is omitted, so the server reseeds
    under a new epoch.
  - `PUT /internal/posts/:id/collab {state, epoch, block_doc?, last_editor_id?, base_revision?, block_edits?}`
    → `{block_revision, epoch}`. 16 MiB body (`collabStoreBodyLimit`), `block_doc` itself
    ≤ 4 MiB, and `prepareForStore` (limits, dedupe `blocks_order` and every `children`,
    sanitize, the nesting checks of #414, v1 + order integrity). `block_doc` omitted/null = store the Yjs state only (server-side
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
- **The importer** (#150, `ImportPostTx`) is the fourth: each imported post is created with
  its converted `block_doc` (through `prepareForStore`) and no Yjs state, so the collab server
  seeds it on first open. See "The importer" below.
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
  a restore (#286, or restore-settings) brings it back (users removed since skipped; none left or a version
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

## Embeds (#425, `embeds.go`, `embeds_resolve.go`)

- Block `embed` v1: `provider`, `ref`, `title`, `caption`, an allowlist (`sanitizeEmbedAttrs`). `ref` is
  checked against its provider's pattern, a title is plain text (`normalizeEmbedTitle`: one holding
  a tag is dropped, `a < b` isn't). `embedVectors.json` (web) is shared with `embeds_test.go`.
- **`POST /embeds/resolve {url}` (`requireContentEditor`) is an outbound request made on a user's
  behalf (plugin webhooks, #460, and media import, #29, are the others; all dial through `outbound_http.go`), so treat
  every line of it as SSRF surface.** The pasted URL only ever yields a
  ref; what is fetched is `embedProviderTable[id].oEmbed`, a literal per provider, asked about the
  URL rebuilt from the ref. HTTPS only, `embedFetchTimeout` 3s for the whole exchange,
  `embedMaxAnswerBytes` 64 KB, no redirect to another host or to HTTP (`refuseOtherHostRedirects`,
  ≤3 on the same host), no proxy from the environment, no cookies, and the dialer refuses internal
  addresses after DNS (`refuseNonPublicAddress`, `outbound_http.go`). Only `title` / `author_name` are decoded; X
  has no title, so it is "Post by <author>". A URL matching no allowed provider is 400
  `embed_not_allowed`, nothing fetched; a title that can't be read is still a 200 with `title: ""`
  (logged as `embed_title_failed` with a fixed reason, never the URL). A new provider is a row in
  the table, `embedProviders`, and `blocks-spec/embeds.ts`; a new route goes in `embedRoutes`
  (`route_auth_test.go`).
- **A provider taken off Allowed embeds** (`editor_allowed_embeds`): `hideDisallowedEmbeds` empties
  those blocks' attrs in every `/public` doc (`publicizeBlockDocs`), so nothing about them reaches
  a reader. Stored docs and versions aren't touched: allowing it again brings them back. Only a doc
  with an embed costs the settings lookup; if the lookup fails every embed is hidden.

## Custom HTML (#428, `000053`, `post_html_snippets.go`, `customhtml/`)

The one place the public site outputs raw HTML. **The markup is not in the Yjs doc.**

- Block `html` v1 holds `snippetId` (a UUID, `customhtml.ValidSnippetID`) and nothing else:
  `sanitizeHTMLBlockAttrs` is an allowlist, so no client can get markup into a working copy through
  the collab store or `POST /posts`. Editors and contributors can move or delete the block.
- `post_html_snippets` (`post_id`, `snippet_id`, `html`, `published_html`), PK on both ids, so
  every lookup names the post and another post's id finds nothing (it renders nothing). `GET
  /posts/:id/html-snippets` is `canReadPost` (the locked preview); **`POST` and `PUT
  .../:snippet_id` are `requireSiteAdmin`**, the only client way in. Ids are the server's.
  Responses carry what was kept after sanitizing. Activity: `html_edited` (throttled).
- **The sanitizer is `customhtml.Sanitize` (bluemonday), an allowlist of elements, attributes, URL
  schemes, CSS properties and CSS functions; nothing is filtered by hand.** No script, style,
  iframe, object, embed, form controls, svg or math, `on*`, `id`, `name` or `data-*`
  (`/gl-embeds.js` reads `data-embed-*`, so they would bypass Allowed embeds); `style` is checked
  per declaration (`safeCSSValue`: an allowlist of functions, so no `expression()`, and `url()` only
  http(s) or a path). It runs on write and on publish; `customhtmltest.XSSPayloads` is the table
  both `customhtml` and the API's tests run. It lives outside `api` so `db` can call it and no
  publish path can leave it out.
- **Publish** (`publishLockedPost`, so Publish, Update, bulk and the scheduler): after the version
  row is inserted, `materializeHTML` copies the post's own sanitized markup into `attrs.html`
  (absent when the id isn't this post's) and rewrites the version. Versions and `/public` never
  read the working table. `published_block_hash` hashes the published doc **without** `attrs.html`
  (`golive_block_doc_without_html_markup`, 000053), or every such post would always have "changes";
  an admin's edit, which changes no `block_doc`, is the other half (`published_html` differs from
  `html`, `golive_post_html_snippets_changed`, inside `golive_post_has_unpublished_changes` and
  `GetPostSettingsState`). A row the published body doesn't use has `published_html` NULL.
- **A scheduled update freezes the markup** with its body (`ScheduleUpdateTx`); it's sanitized again
  when applied, and an admin's later edit is a change waiting for the next Update.
- **Duplicate and templates** copy snippets with new ids (`copyHTMLSnippets`, `customhtml.Rekey`):
  duplicates from the source's rows; a template holds the markup in its own `block_doc` (a snapshot,
  like a version) and a post made from it gets rows. An id that isn't the source's is dropped, so a
  copy never inherits another post's snippet.
- **Restore** (`restore`, #286, and `restore-settings`; editors and admins): the version's markup, read from the version
  and sanitized again, goes back into the working row under the same id, replacing a later edit and
  recreating a deleted row. Like the rest of a restore it reaches the site on Update. An orphan row
  (its block deleted) stays until the post is deleted permanently, so undo and restore find it.
- Tests: `customhtml/*_test.go`, `post_html_snippets_test.go` (real DB: the role matrix, an editor
  token writing directly, another post's snippet, inline markup through the collab PUT and `POST
  /posts`, the payload table on write and on publish, publish, the public page without the row,
  "Changes not published", scheduled updates, duplicate, template, restore) and
  `TestHTMLSnippetRoutesRequireRole` (`htmlSnippetRoutes`, the route audit).

## Site blocks and the site logo (#488, `000057`, `post_blocks_site.go`, `site_logo.go`)

- **Six core flow types** (`flowBlockTypes`, `siteBlockTypes`): `site_title`, `site_tagline`, `site_logo`,
  `navigation`, `search`, `template_part`. They hold no text: what they show is the site's, rendered by the web from
  the template's context. `sanitizeSiteBlockAttrs` is an allowlist per type with defaults left out (the web's
  `normalizeSiteBlockAttrs`; `siteBlockVectors.json` pins both): a level 1 or 2, `link: false`, a logo width clamped to
  32–600, **one** of `menuId` (a positive integer) and `location` (a theme location's name; both set keeps the menu),
  `layout: column`, `overlay: never`, the search texts as plain text (80/80/40 runes), a part's slug. Nothing else: no
  text, pm, links, handlers or a part's content.
- **Where they sit, by the doc's kind** (design 4.2): `prepareForStore` is a post's, where they are inert and never
  refused (a refusal would make every later store of the post fail). `prepareForStoreAs(themeBlocks, kind)` adds the
  kind's rules (`checkSiteBlockPlacement`): a `template_part` never in a `part`. The template tables (#490) store
  through it; an unknown kind is an error, never a post.
- **The site logo:** `settings.site_logo_media_id` (FK media, `ON DELETE SET NULL`). `PUT /settings
  {site_logo_media_id: <id> | null}` (admins; absent keeps): an image, else 400 `invalid_site_logo`. `GET` and `PUT
  /settings` add `site_logo` (`SiteLogoResponse`: public path, size, resized variants, alt, type, names; null for none or
  a failed lookup, logged `site_logo_lookup_failed`). `/settings` is public and cached; media edits and deletes already
  purge (`publicCachePurgeRoutes`). Activity: the field name in `settings_updated`. "Used in" says "Site logo" (#496,
  `site_logo` on `GET /media/:id/posts`).
- Tests: `post_blocks_site_test.go` (the vectors, kinds), `site_logo_test.go` (the setting, the lookup, roles).
- **Site blocks II (#489):** the query loop's three containers are rows of `blockContainers` (`query` at the top or
  in a group holding `post_template`, `query_pagination` and `query_no_results`; those two only in a query, flow,
  columns, details and media & text, never a group or a query), `query_pagination` a core atom that only lives in a
  query (`nestedOnlyAtoms`, with `footnote`), and ten more flow types. `sanitizeQueryAttrs` is the query's closed
  vocabulary, one `/public` parameter each: `inherit` true, `postType` and `taxonomy` names, `perPage` 1–24,
  `orderBy` title, `order` asc, `termIds` (ids, distinct, ascending, ≤10; the editor node's comma list is read too)
  only with a taxonomy, `authorId`. Never a status, a query string or SQL. `checkSiteBlockPlacement` adds
  `post_content`'s rules: never in a part, never inside a `post_template` at any depth, at most one per template.
- **The query loop's reads (#489, `public_posts_query.go`):** `GET /public/posts/type/:type` (#349's pages and the
  published list rows) takes `per_page` (≥1, capped at 24; absent = `posts_per_page`), `order_by` (`date` =
  `created_at`, `title` = the **published** title, `published_title` in `ListPostsWithMeta`), `order`, `terms` (≤10
  ids: one of them in the **published** terms, `post_published_terms`) and `author_id` (in the **published** byline,
  `post_published_authors`); `CountFilteredPosts` takes the same two filters, so `total` agrees. Anything else is a
  400 that reads nothing. Only published posts of a public, active type, as before, so no filter reaches a draft, a
  trashed post or a private type (`public_posts_query_db_test.go`). The cache key is the whole sorted query string,
  so every filter keys it (`TestPublicCacheKeysOnEveryQueryFilter`). `GET /public/posts` (feeds) is unchanged.
- **Site blocks III (#497):** four more flow types, `related_posts` (`count` 1–6, 3 left out; `taxonomy` a name),
  `author_cards`, `table_of_contents`, `color_scheme_switch` (`variant: menu`), and `readingTime: true` on
  `post_byline`. Allowlists like the rest (`siteBlockVectors.json`). No route change: related posts read the cached
  `/public/posts/:id/related` (`limit` ≤ 12, `taxonomy`). No migration.
- **Site blocks IV (#498):** six more flow types, `query_total`, `author_avatar`, `search_results`, `post_facts`
  (`fallback: true`), `site_copyright`, `golive_credit`, and new attrs on the others: navigation `layout: columns` and
  `overlay: menu`, search `variant: icon`, query `feature: true` and `layout: links`, query_title `label: true`,
  query_pagination `end: true`, post_content `width: wide`, post_featured_image `width: wide|full`, post_byline
  `date: true`, post_terms `all: true` (drops `taxonomy`), related_posts `layout: list`, color_scheme_switch
  `variant: popover`. Allowlists, defaults left out (`siteBlockVectors.json`). No route change, no migration.
## Categories, merges and redirects (#331, #146, `000047`)

- **One category per post** (taxonomy `category`, `db.CategoryTaxonomy`): `PUT
  /posts/:id/taxonomy-terms/:term_id` with a category **replaces** the post's category
  (`SetPostTermTx`: the post row `FOR UPDATE`, `RemovePostCategoriesExcept`, `LinkPostTerm`;
  `replaced_term_ids`); `POST`/`PUT /posts` with two categories in `taxonomy_ids` → 400
  `one_category` (`checkOneCategory`). 000047's trigger `post_one_category` refuses a second
  category from any other writer (SQLSTATE 23505, which `db.IsUniqueViolation` now reads).
  Pages and other types may have none; only type `post` gets the default.
- **Default category:** `taxonomy_types.default_term_id` (the category type's
  "Uncategorized", made or adopted by 000047; FK without cascade, so it can't be deleted:
  409 `default_term`). `EnsureDefaultCategory(post_ids)` gives a `post` without a category the
  default; every writer of a post's terms calls it in its transaction (create Tx's,
  `UpdatePostTaxonomyTermsTx`, `RemovePostTermTx` (whose `default_term_id` says it did),
  duplicate, from-template, restore and restore-settings, a category's delete). Deleting a category moves
  its posts to the default, **published sets too** (`ReplaceTermInPublishedSettings` /
  `...ScheduledUpdates`), so no post shows a pending change for it. The default never makes
  posts "related" (`ListRelatedPosts`) unless it is the term asked for.
- **Nesting:** categories nest one level (`checkTermParent`: parent must be top level, a
  category with children can't get one; 400 `nesting_too_deep`). Other hierarchical
  taxonomies are unchanged. A category slug can't be a post type's or taxonomy's name or a
  fixed route's first segment (`reservedCategorySlugs`; 400 `slug_reserved`).
- **000047's data fix** (deterministic): a post with several categories keeps the one it was
  given first (`post_taxonomy_relationships.created_at`), then the lowest term id, never the
  default when it has another; deeper categories move under their top-level ancestor (one in
  a loop becomes top level); published sets and pending scheduled updates keep the working
  copy's category (`golive_keep_one_category`), templates the lowest non-default one; a
  version with several is cut down when restored. Every `post` without a category (working
  and published) gets the default. The down migration doesn't restore what was removed.
- **Category URLs:** `post_url_structure` `category` = `/{category-slug}/{post-slug}` for type
  `post` (`category_urls.go`, the web's `postPath`). Responses carry `category_slug`
  (`golive_post_category_slug(post, published)`: the published category on `/public` rows,
  `ListPosts`' `published_category`, search hits, menus; the working one in admin lists). The
  web router 301s any other `/{x}/{post slug}` to the post's URL, so category renames need no
  rows.
- **Merge:** `POST /taxonomy/terms/:id/merge {source_ids}` (editors+admins; flat taxonomies
  only, else 400 `merge_not_supported`; `merge_into_itself`, `merge_type_mismatch`, 409
  `default_term`) → `MergeTaxonomyTermsTx`: posts get `:id` (working, published, scheduled
  updates), sources deleted, `/{taxonomy}/{source}` → `/{taxonomy}/{kept}` redirects. Activity
  `terms_merged` (object `term`).
- **Redirects** (`redirects.go`, `db/sqlc/redirects_tx.go`): `redirects` (from_path unique,
  to_path a site path or http(s) URL, 301|302, source manual|post|term|merge, created_by SET
  NULL). Paths are stored **decoded**, no query/fragment/trailing slash (`normalizeSitePath`;
  never under `/gl-admin`, `/api`, `/uploads`, `/themes`). Automatic ones: a **published**
  post's slug change (old → new URL under the current structure, in `UpdatePostWithSlugTx`), a
  public term's slug change (`UpdateTaxonomyTermTx`), a merge. `addRedirect` keeps the table
  collapsed under an advisory lock: rows pointing at the new from_path are retargeted (A→B,
  B→C ⇒ A→C), an automatic redirect drops a row from its (now live) target, a manual one to a
  path that redirects takes that path's target, and a loop is `ErrRedirectLoop` (400
  `redirect_loop`). Admin routes (`requireSiteAdmin`, like settings): `GET /redirects?q=&limit=
  &offset=`, `POST /redirects` (409 `redirect_exists`), `DELETE /redirects/:id`; activity
  `redirect_created`/`redirect_deleted` (object `redirect`, admin-only in the feed). Public:
  `GET /public/redirects?path=` → `{to_path, status_code}` or 404; the web asks only for a page
  it would answer 404.
- Tests: `db/sqlc/taxonomy_tx_test.go` (real DB: replace, trigger, default, delete, merge,
  chain collapse), `api/redirects_test.go` (mock: routes, validation, codes, roles),
  `api/taxonomies_redirects_db_test.go` (real DB: slug changes answer the public lookup,
  category URLs, the rules through the routes, merge).

## The importer (#150, `000065`, `imports.go`, `import_*.go`, `importer/`, `db/sqlc/import_tx.go`)

- **Admins only** (`requireSiteAdmin`): `POST /imports` (multipart `file`, `IMPORT_MAX_SIZE`,
  100MB, its own cap: `bodyLimitOverrides` 0), `GET /imports[/:id[/items?status=&dropped=true]]`,
  `POST /imports/:id/start {authors: {login: member id, 0 = you}, types: {wp type: GoLive type, "" =
  skip}}` (members need a content role, types must be active; 409 once started), `POST
  .../cancel`, `DELETE /imports/:id` (not while queued/running; posts and media stay). The
  editor's notice: `GET /posts/:id/import-notice` + `POST .../dismiss {item_id}`
  (`requireContentEditor` + `canReadPost`).
- **Reading** (`importer/`, no DB, no network): the upload is read at once into a job
  (`import_jobs` `mapping`, one `import_items` row per post/page, a zip's images in
  `import_files`). WXR is an `encoding/xml` token stream, strict, **a DOCTYPE (so any entity)
  is refused** (`unsafe_xml`), nesting ≤ 64, UTF-8 only, ≤ 20,000 items. A Markdown zip is read
  from its central directory: every name checked first (no absolute paths, `..`, backslashes,
  drive letters, control characters; **a symlink refuses the whole zip**), ≤ 5,000 entries,
  `.md` ≤ 2 MiB, images ≤ `MAX_UPLOAD_SIZE`, total ≤ 4 × the cap, an entry expanding > 200× (past
  1 MiB) or whose header lies is a zip bomb; every read is cut off at its cap. Front matter is
  YAML (title, date, lastmod, slug, tags, categories, description, draft, type, author, image,
  aliases, id); goldmark (GFM) renders the body with raw HTML passed to the converter (which
  never outputs HTML). Refusals are 422 with a fixed `code` + message (`importer.Error`).
- **The job** (`import_worker.go`, `RunImports` from `main.go`, `IMPORT_INTERVAL` 2s, 0 = off,
  every replica): `ClaimImportJob` (`FOR UPDATE SKIP LOCKED`, 2-minute lease renewed per item, a
  new `lease_token` per claim = the fencing value every write checks), terms once (`term_ids`),
  then one item at a time in position order (a page's parent first). **Each post is one
  transaction** (`ImportPostTx`): advisory lock on the item's key, "imported before?" (any job's
  `imported` row with that `source_key` and its post still there → skipped
  `imported_before`), renew the lease (lost → `ErrImportLeaseLost`, nothing written), the post
  (draft), byline, terms + `EnsureDefaultCategory`, featured image (post_media 0 +
  `_thumbnail_*` meta), custom HTML snippets, `SyncPostContentMedia`, the export's dates
  (`created_at`, `changed_at`, `first_published_at` before publishing: 000061's trigger keeps the
  first value), `publishLockedPost` when it was published, the redirects, and the item's
  result. A crash leaves the item pending; a stopped job's next fenced write fails.
  Publishing runs `runPublishGuards` first (`PublishViaImport`): a refusal imports a draft with
  the reason in the report.
- **Mapping:** publish → published; draft, pending, future, private → draft (noted); trash and
  auto-drafts → skipped at upload. Authors → the chosen member (removed/demoted since → the
  importer). Categories: one per post, the first the export lists (`extra_categories` noted);
  deeper WordPress categories go under their top-level ancestor; a slug another taxonomy has
  gets `-2`…, a reserved category slug `-category`; a same-taxonomy same-slug term is reused.
  Other taxonomies, comments, menus, attachments nobody uses aren't imported (counted in the
  summary). Excerpt → description, slug kept (`-2` when taken, reported). **Redirects:** the
  old permalink's path (and Markdown `aliases`) → the new public path under the current URL
  structure, 301, source `import` (000065 widens `redirects_source`); `?p=12` links have no path.
- **Converter** (`import_convert.go`, `import_gutenberg.go`, `import_shortcodes.go`): block
  editor content is parsed like `parse_blocks`; classic content gets wpautop's rule (blank line =
  paragraph, newline = hard break) and the shortcode pass ([caption] → figure, [gallery ids] →
  gallery, [embed]/[youtube]/[vimeo]/a bare provider URL line → embed, [video]/[audio] → media;
  any other shortcode **alone on its line** → dropped; inside a sentence it stays text). It
  builds exactly the bridge's shapes (`pmNodeToBlock`): marks per #418 (code excludes the
  others), lists with nested lists in their item's pm, quotes (`cite`), pull quotes, code
  (language), tables (header row, spans), images (v2: `mediaId`, `src`, alt, caption runs,
  wide/full), galleries (#424, 2–4 columns), embeds (#425; another provider → a link
  paragraph), video/audio/file, buttons (unsafe hrefs left out), spacer (nearest step),
  columns (33-67/67-33), group (tinted, wide/full), details, cover, media & text, custom HTML
  (`wp:html` → a snippet through `customhtml.Sanitize`: admins import), reusable blocks inlined.
  `fit` applies the nesting table (a container its parent can't hold, or with too few/many
  children, gives its children). What has no equivalent is **dropped and reported**
  (`importDropped`: label, the text it followed, the original ≤ 8 KB for "Copy the original as
  text"): scripts, styles, forms, objects, SVG, frames from other hosts, dynamic core blocks
  (latest posts, query, navigation…), plugin blocks without saved HTML, unknown shortcodes.
  The doc then goes through `prepareForStore`; `import_convert_test.go` asserts the sanitizer
  has nothing left to remove and writes `web/gl-admin/lib/collaboration/importedDocs.vectors.json`
  (`UPDATE_IMPORT_VECTORS=1`), which `importedDocs.test.ts` seeds with the real bridge: no drops.
- **Media** (`import_media.go`): #29's path, never a hotlink. WordPress: only the export's own
  host (with or without `www.`), through `outbound_http.go`, **redirects only on that host**
  (`siteImporter`), the attachment's original URL (a `-300x200` copy is mapped back), alt from
  the post or the attachment, the attachment's title as the name; `saveImportBody` (sniffed
  type, `MAX_UPLOAD_SIZE`, unguessable names) + `createImportedMedia` (metadata stripped,
  variants). Markdown: only the zip's files, found from the post's folder (root paths also
  under `static/`, `public/`); remote images aren't fetched. The kind must fit the block
  (`wrong_kind`). `import_media` (source URL or `sha256:` of a zip file → media) makes resumed and
  repeated imports reuse files; deleting the media drops the row. Failures are fixed codes in the
  item's `media_failed` (URL shown without its query), never fatal, never logged with the URL.
- **Activity:** `imported` per post (object post, payload `post_type`, `import_id`,
  `published`; not in "Continue editing"), `import_started` / `import_finished` (object `import`,
  admin-only in the feed; finished has the counts).
- Tests: `importer/importer_test.go` (the real-world fixture `importer/testdata/
  wordpress-export.xml`: classic and block posts, pages, two authors, nested categories,
  galleries, shortcodes; the refusals), `import_convert_test.go` (both posts and Markdown, the
  rules), `imports_db_test.go` (real DB: upload, summary, mapping, the job, media from a local
  site, redirects, report, notice, idempotent re-run, Markdown, stop and fencing, roles).

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

## Command palette (#41, `command_palette.go`)

- `GET /search?q=` (content roles): at most 5 posts, pages, media and terms, plus users for
  admins only (the key is left out otherwise, and the query isn't run). One route because the
  per-type ones would mean five or more rate-limited calls per pause in typing (terms are per
  taxonomy, `/users` is admin-only) and the client would need a copy of who gets what.
- Posts and pages: `SearchCommandPalettePosts` (title or slug, titles starting with the text
  first, then latest edited; `postsViewerID`, never the trash; only types post and page).
  Deliberately not `SearchPostsWithMeta`: its ranking took 1-7 s at 30,000 posts; this route
  answers in about 200 ms at 30,000 posts plus 30,000 media, so it has no index. Terms:
  `SearchTermsAcrossTaxonomies` (`show_ui` taxonomies only). Users:
  `SearchCommandPaletteUsers` (name or username, not the email, which the row doesn't show,
  so "co" doesn't list every .com address). `q` is cut by
  `normalizeSearchQuery`, LIKE wildcards escaped.
- The palette cancels stale requests, so a search the client aborted answers **499**
  (`statusClientClosedRequest`), not a 500 that would reach the metrics and error reporter.
  Listed in `route_auth_test.go` (`commandPaletteRoutes`).

## Site settings (#330)

- `settings` (singleton) gained `site_tagline` (≤160, one line, trimmed), `site_language`
  (BCP-47 from `siteLanguages`), `site_timezone` (IANA, `time.LoadLocation`; `time/tzdata` is
  embedded so the image needs no zoneinfo; `Local`/`""` refused), `date_format`
  (`month_day_year`|`day_month_year`|`iso`), `editor_markdown_shortcuts` and
  `editor_allowed_embeds` (`embedProviders`, the sites embeds may come from, #425; ≤20, deduped; absent keeps, `[]` clears) (`000025`).
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
  read it, and the write routes that don't load the post (media links, SEO, restore, restore-settings)
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
  `settings_updated` (`fields`); review requests (#323, below). The trash (#327): `trashed` (`from_status`), `restored` (`post_status`) and permanent delete as `deleted`, recorded by the per-post helpers in `posts_trash.go` so the bulk actions log each post too (bulk publish logs `published`: `publishPostByID` records it for both routes). Theme extension settings aren't recorded yet. Plugins (#455, below): `plugin_*`, admin-only, settings included (#457).
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
  `review_requests` (#323, below: editors and admins; `null` otherwise).
- **Retention:** `ACTIVITY_RETENTION` (default 2160h = 90 days, 0 = keep everything);
  `RunActivityRetention` (main.go, every replica) prunes hourly in batches of 5000.
- Handler tests on a mock store get an in-memory recorder (`newActivityWriter` is swapped in
  `test_utils_test.go`; read it with `activityOf(t, server).verbs()`), so they don't expect the
  inserts. `activity_test.go` covers the write paths, visibility, feeds and retention against
  the real database.

## Review requests (#323, `000044`, `review_requests*.go`)

- `review_requests`: post, `requested_by`, optional `reviewer_id` (an editor or admin; NULL = any of
  them), `message` (≤1000, plain text), `status` open | published | dismissed | changes_requested,
  `resolved_by`, `resolution_note` (≤2000, required with changes_requested; plain text, comments #192
  aren't built), times. User FKs SET NULL (a request naming a removed member is open to all), the
  post CASCADE. **One open request per post** (partial unique index; `CreateReviewRequest` is `ON
  CONFLICT DO NOTHING`): a second `POST /posts/:id/review-request` answers **409
  `review_already_requested`** with the open one and emails nobody; withdraw and ask again to name
  someone else.
- Who: asking = `canRequestReview` (= `canEditPost`: contributors their own posts but scheduled,
  moderators any; trashed → 409); the reviewer must be another member who `canReview` (400
  `invalid_reviewer`, the same for an unknown id). Seeing a post's requests (`GET
  /posts/:id/review-request`, the list indicator) = `canSeeReviewRequests` (moderators, the owner;
  another contributor gets `null` / nothing, and `/review-requests/:id/*` answers 404). Dismiss =
  a reviewer or the requester (`withdrawn` in the event); request changes = reviewers only
  (`requireContentEditor`). `GET /posts/reviewers` lists editors and admins (public fields).
- **Publishing resolves it, whatever the path**: the `posts_resolve_review_on_publish` trigger
  (post_status becomes published, or a new `published_version_id`) sets `published`, credits the new
  version's `created_by` (who published, or who scheduled it; NULL for a status set through PUT) and
  inserts the `review_resolved` activity row in the same transaction. Publish/Update, bulk, #147's
  scheduler, #335's scheduled update and PUT all go through it, so a new publish path needs nothing.
  Unpublish, archive, trash and restoring a published post from the trash (the old live version,
  not the reviewed changes) leave it open (Needs attention hides trashed posts).
- **Email** (`mailer` templates `review_requested`, `review_changes_requested`), after the response
  (`runInBackground`), one message per recipient: the named reviewer, or with none **every editor and
  admin but the requester** (≤100, the most recently active first; they also see it on Home). Changes
  requested emails the requester the note (not when they asked for changes on their own request).
  Links: `PUBLIC_BASE_URL` + `/gl-admin/content/edit/<id>`. The answer never says who was emailed;
  logs carry ids and counts only. Activity: `review_requested` (`request_id`, `reviewer_id`),
  `review_dismissed` (`withdrawn`), `review_changes_requested`, `review_resolved` (the trigger);
  never the notes. `ListActivity` shows the `review_*` events of a published post to reviewers and its
  owner only, like the requests themselves.
- `GET /home/needs-attention`'s `review_requests` (`ListReviewRequestsForReviewer`, moderators): open
  requests naming the caller, naming nobody, or naming someone who can no longer review; never their
  own, never a trashed post; theirs first, then the oldest. `GET /posts/:id/review-request` is the
  open request, or the latest one with changes requested while no version was published after it
  (the editor's note). Lists (`with_meta`, `/posts/search`) attach `review_request` per row
  (`ListOpenReviewRequestsForPosts`, one query per page; a failure leaves it out), and
  `review=pending` filters them (a contributor: only their own posts). Tests:
  `review_requests_test.go` (real DB).

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

## Front page and page templates (#336, `000045`, `front_page.go`, `page_templates.go`)

- **Front page:** `settings.front_page_id` (FK posts, `ON DELETE SET NULL`; NULL = the latest
  posts). `PUT /settings {front_page_id: <id> | null}` (admins, like every setting; absent keeps):
  only a **published page**, else 400 `invalid_front_page`. The id stays when the page is later
  unpublished, archived or trashed: `GET /public/front-page` (the `publicPostView` of
  `/public/posts/:id`) answers **404 `no_front_page`** unless `GetPublicFrontPage` finds it
  published, type `page`, and that type public and active, and the site's `/` shows the latest
  posts until it is published again. `GET /settings` returns the id as stored (an id is not
  content). Only `front_page_db_test.go` touches it in tests (a shared singleton; it restores it).
- **Templates:** `posts.page_template` (`''` = the theme's default; CHECK `[A-Za-z0-9_-]{0,64}`, or
  `block:<name>` since 000062, below).
  **In the snapshot (decision):** `golive_post_settings()` has `page_template`, so a template
  change on a published page waits for Update like every other setting (#358), `golive_post_settings_changed`
  sees it, versions record it and a restore (or restore-settings) brings it back (`RestorePostSEO` takes it; a
  version without one keeps the working one). 000045 gave every stored snapshot (versions, published,
  #335's scheduled updates) `""`. `/public` answers the published one as `post.page_template`
  (`publishedPageTemplate`); `ListPosts` rows carry the working one (the Pages list), the with_meta
  lists don't.
- `PUT /posts/:id/template {page_template}` (content roles + `canEditPostDetails`, trashed → 409,
  pages only → 400 `template_pages_only`). `"default"` is stored as `""`; any other name must be in
  the active theme's `config.page_templates` (400 `unknown_template`, also with no active theme).
- **The list is the theme scan's** (`scanPageTemplates`): every `layouts/page/*.astro` (valid names
  only), `default` first, then theme.config.ts's `layouts.page` order (`{ file, label, description }`
  entries; the simple `variants` form names none), then undeclared files by name, labelled from the
  name. A declared layout without its file is left out. Stored as `config.page_templates`; the admin
  lists it, the web resolves names against its own build (`pageLayoutVariant`). A stored template the
  active theme lacks (theme switch) is kept and renders as the default.
- **Builder page templates (#494, `000062`, design `docs/design/theme-builder.md` 10):** a page may store
  `block:<name>` (CHECK widened to `^([A-Za-z0-9_-]{0,64}|block:[a-z0-9-]{1,64})$`; a layout name can't hold
  `:`), the active theme's site template `custom-<name>`. A reference by name, never an FK: a reset, deleted or
  other theme's template leaves it stored, and the page renders the default until it's published again. PUT
  accepts one only while the site would render it, as the resolve does: a **published** override of the active
  theme (`HasPublishedSiteTemplate`, `published_block_doc` not NULL) or a `custom-<name>` the theme ships
  (`config.block_templates`); else 400 `unknown_template`. `GET /posts/page-templates` (every content role) is
  what the Template field offers: `{theme: {slug, name} | null, templates (the layouts), builder_templates:
  [{name: "block:<n>", label: title}]}` (`ListPublishedCustomPageTemplates` plus the shipped ones, by label; a
  `custom-` slug with `_` can't be stored, so it's left out). Nothing else changed: it is still the snapshotted setting (Update, versions, restore and restore-settings), and the
  PUT still doesn't purge; a design publish purges as #492 does. Tests: `page_templates_test.go` (mock),
  `page_templates_db_test.go` (real DB through the routes: offered and accepted only once published, live on
  Update, kept after a reset, restored by a version, the CHECK).

## Block comments (#192, `000048`, `post_comments.go`)

- Design: `docs/design/block-map-yjs-schema.md` ("#192: block comments", #315 Option C). Threads
  (`post_comment_threads`: post, `block_id` = the block's `data-block-id`, `resolved_at/_by`) and
  plain-text `post_comments` (≤4000 characters, trimmed, no NUL; `edited_at`, `deleted_at`) are API
  rows, **never in the Yjs doc, `block_doc` or a version**, so reseeds, restores and restarts keep
  them. The API checks only a block id's **format** (`^[!-~]{10,128}$`, the table's CHECK), not that
  it's in the stored `block_doc` (a block typed a second ago isn't stored yet); the editor lists
  threads whose block isn't in its doc as orphans. Duplicates and templates copy none. User FKs SET
  NULL, the post CASCADE.
- **Who (`auth_posts.go`):** read and write comments = `canReadPost` (`canCommentOnPost` adds "not
  trashed", 409): moderators any post, a contributor their own and published ones (view-only
  included, with or without a #321 grant). Resolve/reopen (`canResolveCommentThread`) = the thread's
  starter or `canEditWorkingCopy` (moderators, the contributor owner, a granted collaborator), so the
  owner of a post under review (#323) resolves the reviewer's threads. Edit = the author only (admins
  too). Delete = the author or a moderator. A deleted comment keeps its row (body emptied); deleting a
  thread's last live comment deletes the thread (`DeletePostCommentTx`, thread row locked first).
- Routes (content roles; every one answers the whole `CommentsResponse` with per-item `can_*`):
  `GET|POST /posts/:id/comments`, `PUT|DELETE /posts/:id/comments/:comment_id`, `POST
  /posts/:id/comment-threads/:thread_id/{replies,resolve,unresolve}` (resolve/unresolve idempotent).
  Listed in `route_auth_test.go`'s `commentRoutes` (every method answers 401 anonymously, none under
  `/public`) and `postReadRouteTemplates`.
- After every write `afterCommentWrite`: activity (`commented` with `reply`, `comment_resolved`,
  `comment_reopened`, `comment_deleted` with `author_id`; ids only, never the body; edits aren't
  recorded) and `notifyCollabComments` → the collab server's `POST
  /internal/documents/post-<id>/comments` (best effort, after the response), which broadcasts
  `{"type":"comments"}`. **Mentions in comment bodies are out of scope (decision, #320):**
  comments stay plain text; an @name there is text and notifies nobody. A follow-up would
  hook into `afterCommentWrite` and reuse #320's ledger and `notifyNewMentions`.
- Tests: `post_comments_test.go` (real DB: every role, CRUD, resolve, trash, nudges, activity, not
  public, the delete race) and `auth_comments_test.go`.

## Reader comments: storage, settings, the state rule, retention (#522, `000061`, `discussion*.go`)

- Design: `docs/design/reader-comments.md` (#499; decisions in its section 18). `/public` reads
  them since C3 (#523, below) and writes them since C4 (#524, below), and
  `settings.comments_enabled` starts off with its switch hidden until #526/#527. Never #192's
  names: `reader_comment*`, `commenter*`, `discussion*`.
- **Tables (6.1):** `commenters` (one per address, `email_lower` UNIQUE; never public, never
  logged), `commenter_keys` (browser keys as SHA-256), `reader_comments`,
  `reader_comment_unsubscribe_tokens`, `discussion_mail` (the outbox; recipients by id). Post FK
  CASCADE: a post deleted for good takes its thread, its commenters stay; trash and restore
  don't touch comments. `root_id` CASCADE / `parent_id` SET NULL; CHECKs pin one author, trash ⇔
  `trashed_from`, the tombstone's empty fields, a confirm token only while unconfirmed. **lib/pq
  sends a nil `[]byte` as an empty bytea, not NULL**: `CreateReaderComment` wraps the hashes in
  `NULLIF(…, '')`; any new bytea insert needs the same.
- **Deleting (6.4):** always `db.DeleteReaderCommentTx` (never `DeleteReaderCommentRow` alone): it
  locks the comment and the rows answering it or in its thread, and makes a **tombstone**
  (`TombstoneReaderComment`: `removed_at`, empty body and name, no commenter/member/hash, status
  approved) when one of them is approved, else deletes (the cascade then takes only unapproved
  rows). Trash is a status (`TrashReaderComment`/`RestoreReaderComment`), replies untouched;
  an unconfirmed comment can't be trashed (no row: it expires, and keeps its confirm token).
  A tombstone has no unsubscribe token (the Tx deletes it; the job's
  `DeleteTombstoneUnsubscribeTokens` for the ones it makes).
  **C6's approval of a reply should lock its root and parent (`FOR SHARE`) first**, so the
  retention job (`SKIP LOCKED`) can't cascade a reply being approved.
- **`posts.discussion`** (`default|open|closed|off`) is **not in `golive_post_settings()`**: it
  applies at once and never shows "changes not published"; `UpdatePostDiscussion` doesn't touch
  `changed_at` (no `post.saved` event). `GET` and `PUT /posts/:id/discussion` (`posts_discussion.go`):
  **editors and admins only** (`requireContentEditor`: contributors have no access to Discussion,
  decision 3, #527), PUT 409 on a trashed post, activity `post_discussion_changed {from, to}`, purges
  when published (`publicCachePostDetailRoutes`), both answer `{post_id, discussion, state, closes_at,
  first_published_at}` (the last is the rule's input, so the editor's section applies the TS twin).
  The settings' checks are pinned by `web/gl-admin/lib/discussionSettingsVectors.json`
  (`TestDiscussionSettingsVectors`; the admin's form refuses the same values, #527).
- **`posts.first_published_at`**: the `posts_first_published` trigger sets it when `post_status`
  first becomes published (insert or update) and keeps it forever after (unpublish, Update, trash,
  restore, even a direct write). Backfilled from the earliest `post_versions` row.
- **The state rule (12.4, `discussion.go`):** `discussionSetting(site, type, post)` (clock-free:
  `{state, closes_at}`, what a cached `/public` answer may carry) and `discussionState(setting,
  now)`. An explicit Open ignores the timer; an explicit Open/Closed applies even on a type without
  the Comments field (12.4 reads `supports` only for the default); a type not public or inactive is
  off. Twin: `web/src/lib/discussion.ts`, both suites run `web/src/lib/discussionStateVectors.json`.
  `server.postDiscussionSetting(ctx, post)` reads settings and the type.
- **Text (6.3, `discussion_text.go`):** `normalizeReaderCommentBody` (CR LF → LF, controls but LF
  and tab and bidi controls refused `body_invalid`, line-end spaces dropped, ≥3 blank lines cut
  to 2, trimmed, 2–4000 code points: `body_too_short`/`body_too_long`) and
  `normalizeReaderCommentName` (1–60, one line). Vectors: `web/src/lib/discussionTextVectors.json`.
- **Network hash (7.2):** `discussionNetworkHash(PASETO local key hex, ip)` = HMAC-SHA256 of
  `clientKey(ip)` under HKDF(local key, `golive.discussion-network`). No IP is ever stored.
- **Settings (12.1, `discussion_settings.go`)** are `GET/PUT /settings` fields (`comments_*`;
  ranges checked in Go since 0 is a value; word lists trimmed, deduped ignoring case, ≤500 × ≤64;
  `comments_privacy_page_id` a published page, `checkPublishedPageSetting` shared with the front
  page). **The hold/spam word lists are admin-only**: GET `/settings` adds them only for a valid
  admin bearer (`optionalCallerIsAdmin`, never answers 401), which the public cache never stores.
- **Post types (12.2):** 000061 adds `"comments"` to `post`'s `supports`. `PUT /post-types/post|page`
  accepts `supports` alone, differing from the stored list only by `"comments"`
  (`SetPostTypeComments`); anything else is still 409 (`code: system_post_type`).
- **Retention (6.6, decision 13; `discussion_maintenance.go`):** `RunDiscussionMaintenance` from
  `main.go`, `DISCUSSION_MAINTENANCE_INTERVAL` (1h, 0 = off), every replica, every statement `FOR
  UPDATE SKIP LOCKED`, counts-only logs. Unconfirmed > 48h, pending > 90d, spam/trash > 30d (trash
  from `moderated_at`) are deleted, or tombstoned when approved replies hang from them; orphan
  tombstones go (up to 3 passes); network hashes > 30d NULLed; expired keys; commenters with no
  comments and no keys unseen 30d, unless blocked or spammed in the last 90d.
- Tests: `discussion_db_test.go` (real DB: lifecycle, tombstones, constraints, first publish, the
  snapshot rule, every retention rule, the routes, settings, post types) and `discussion_test.go`
  (vectors, network hash, word lists).
- **Public thread reads (#523, `discussion_public.go`, `db/query/discussion_public.sql`, design 6.2,
  9.1):** `GET /public/posts/:id/comments?page=N` → `{discussion, threads: [{comment, replies,
  reply_count}], pagination}` (`comments_per_page` threads, each with its first 100 replies;
  `comments_order` orders threads, replies always oldest first; `comments_threading: flat` = every
  shown comment on its own, no `replying_to`); `?thread=<root id>` → `{discussion, thread}` with every
  reply (`page` and `thread` together: 400). 404 for a post `/public` doesn't serve (not published,
  or its type isn't public and active), past the last page, and for anything but a shown root of
  that post. **Only approved comments**: "shown" = approved and not a tombstone; a hidden root or
  reply that a shown comment answers is listed as a placeholder (`removed: true`, empty name and
  body: the SQL blanks them), so unapproving never hides replies. `replying_to` = the shown parent's
  name on a reply to a reply. A member's comment: current name, avatar, badge `author` (on the
  **published** byline) or `staff`. `GET /public/posts/:id`, `/slug/:slug` and the front page carry
  `discussion: {state, closes_at, count}` (`publicPostView`; `off` counts 0 and lists nothing; a
  failed read is `null` with `Cache-Control: no-store`, never a failed post; with comments off for
  the site they read the settings only).
  **Cached and clock-free:** `state` never applies `closes_at` (the renderer and the write path
  do). `PublicReaderComment` is built field by field; no email, commenter id, status, hash or token
  (7.1: `TestPublicCommentAnswersHoldNoAddress` in `route_auth_test.go`, which also lists every
  `/public` comment route in `publicReaderCommentRoutes`). Mock tests of the post reads call
  `expectDiscussionOff(store)` after their own expectations.
- **Purges (#523, `discussion_purge.go`, design 10):** comment writes call
  **`server.purgeDiscussion(ctx, log, postID, event)` after their commit**, never inside a
  transaction; `discussionEventPurges` decides (published, hidden, removed, edited, bulk purge;
  unconfirmed, pending, unseen don't), `discussionStatusEvent(from, to)` names a status change
  (`""` = a new row), and a post known not to be published skips it (`postID` 0 = several posts:
  purge once per bulk request). Such routes go in **`publicCacheDiscussionRoutes`** (neither purge
  list: the purge depends on the outcome). The Discussion choice and Settings saves purge through
  the middleware; publish/unpublish/trash/delete cover the thread; the retention job never changes
  a public thread and doesn't purge. Tests: `discussion_public_db_test.go`,
  `discussion_purge_db_test.go` (miniredis + DB: each event, pending-only doesn't purge, after
  commit via `purgeWatch`), `discussion_public_test.go`, `discussion_purge_test.go`.

## Reader comments: the public write path (#524, `discussion_write.go`, `discussion_rules.go`)

- **The API's first anonymous writes outside `/auth`**, under `/public` (server-side only: the
  web's `/gl-comments/*` endpoints call them, web/CLAUDE.md): `POST /public/posts/:id/comments`,
  `POST /public/discussion/confirm {token}`, `POST /public/discussion/unconfirmed/:id {action:
  publish|discard}` (the confirm page's step 5). All answer 409 `comments_off` while
  `comments_enabled` is off. Every anonymous write is listed with its reason in
  `route_auth_test.go`'s **`publicPOSTRoutes`** (`TestAnonymousWritesAreListed` walks the router:
  a write that doesn't answer 401 anonymously must be there; every `/public` write must be).
  Bodies are capped at 24 KiB (`discussionBodyLimit` in `bodyLimitOverrides`: 4000 emoji are
  16,000 bytes, so the design's 16 KiB was too tight).
- **No address enumeration (as open signup):** without a valid browser key for the typed address
  the answer is always 202 `{outcome: confirm_email, post_url}`. Before it, only the post is read
  (settings, `GetReaderCommentPost`, the type, the parent, `CountPendingReaderCommentsForPost`) and,
  when `GoLive-Commenter-Key` is sent, `GetCommenterByKeys` (keys **and** address: a key for another
  address, expired or unknown, finds nothing, so it's no key). Everything that touches the address
  runs after the response (`processUnconfirmedReaderComment` in `runInBackground`): `EnsureCommenter`
  (never renames an existing row: typing an address proves nothing), the 20-unconfirmed cap (silent
  drop), the guard, the spam routes (stored as spam, **no mail**), the store, the 10-minute mail
  cooldown (`commentMail`, `newIntervalLimiter`, taken only after the store succeeds; a comment in
  it keeps a token nobody is mailed) and the mail, to the address as typed. The post's 200-pending
  cap is checked only for a comment that would wait (no key, or a keyed one the rules hold). `TestReaderCommentNoAddressEnumeration` compares unknown, known, verified, cooled-down,
  blocked, over-cap and other-key cases, the pre-response calls included.
- **The mail** (`reader_comment_confirm` template, `mailer.ReaderCommentConfirm`) has no field for
  the name or text: site title, the post's published title and URL, the link
  `PUBLIC_BASE_URL/comments/confirm#token=…` (48 h). Only the token's SHA-256 is stored
  (`confirm_token_hash`).
- **Confirm** spends the token only by POST (`PublishReaderCommentTx`: thread FOR SHARE, then the
  row FOR UPDATE, token re-checked; every bad link 400 `invalid_token`; a parent gone 404
  `parent_not_found` and nothing is spent), publishes or holds **that comment alone**, verifies the
  commenter (name from the comment), stores a new browser key (`set_key`, its hash in
  `commenter_keys`, a year) and lists the address's other unconfirmed comments (`others`: post
  title, URL, first 100 characters), which only the key can then publish or discard one by one.
- **Keyed comments** (`createKeyedReaderComment`) decide at once: 201 `published` (purges) or 202
  `pending` (also spam, silently). `CreateReaderCommentTx` re-checks a reply's parent under a share
  lock (`ErrReaderCommentParentGone`). A reply goes only under an approved, shown comment of the
  same post; `root_id` is the parent's root.
- **Rules** (`decideReaderComment`, design 4.2): spam first (blocked commenter → `blocked`,
  honeypot `website` → `honeypot`, a spam word in text or name → `spam_word` + the word, a guard →
  `plugin`), then holds (`plugin`, `member_name`, `held_word`, `links` over `comments_max_links`,
  `previous_spam` within 90 days, `moderation_all`, `first_comment`), else approved. The rules
  never set `last_spam_at` (a moderator's Spam does, #526). Words: folded (NFD, marks dropped,
  lower case), word boundaries by letter/number runes; links: http(s) only, trailing punctuation
  trimmed. Both pinned by `web/src/lib/discussionRulesVectors.json` (twins in
  `web/src/lib/discussion.ts`). Member names: `ListMemberNames`, folded and spaces collapsed.
- **The guard's hook** (`discussion_guard.go`): `server.readerCommentGuard`, which `NewServer` sets
  to `runCommentGuards` (#530, below). Called after core's checks, before the insert, with the
  candidate (email, IP, UA included); hold or spam only (an approve is ignored); a hold on an
  unconfirmed comment is stored (`held_reason plugin`) and applied at confirmation without asking
  again.
- **Limits** (`ratelimit.go`): `commentPost` per IP (`RATE_LIMIT_COMMENT_POST_PER_MINUTE`, 5,
  middleware, no exempt CIDR), `commentAddress` per IP + address
  (`RATE_LIMIT_COMMENT_ADDRESS_PER_MINUTE`, 3), `commentMail` (silent, 10 minutes, on when
  `commentPost` is), `commentConfirm` on the two confirmation routes (the account-token limit).
  The IP is the browser's: the web endpoint appends its peer to Caddy's X-Forwarded-For, read
  from `TRUSTED_PROXIES` only (`TestReaderCommentRateLimitsKeyOnTheBrowser`). 200 pending on a post
  → 429 `comments_busy`.
- **Purges:** through #523's `purgeDiscussion` (`discussion_purge.go`), after the commit: a keyed
  POST with `discussionStatusEvent("", status)`, a confirmation or Publish with
  `discussionStatusEvent(unconfirmed, status)`, so only a comment that became approved purges.
  The three routes are in `publicCacheDiscussionRoutes` and `publicReaderCommentRoutes`.
- Logs: ids, status and held reason only (`requireNoPersonalData` checks address, name, text,
  token and key in the tests).
- Tests: `discussion_write_test.go` (mock), `discussion_rules_test.go` (vectors, one case per hold
  reason and spam route), `discussion_write_db_test.go` (real DB: the flow to the key, a link
  confirming only its own, single use, expiry, keys for another address, step 5, the Tx
  re-checks, no address in any answer).

## Per-block "Last edited by" (#328, `000049`, `post_block_edits.go`)

- Design: `docs/design/block-map-yjs-schema.md` ("#328", #315 Option C). `post_block_edits`
  (post, `block_id` = a key of `block_doc`'s `blocks`, `user_id` SET NULL, `edited_at`), one row
  per block. **Only the collab store writes it**: `PUT /internal/posts/:id/collab`'s
  `block_edits: [{block_id, user_id, edited_at}]` go into `StorePostCollabTx` with the
  `block_doc` they describe (`writeBlockEdits`: prune the rows of blocks not in it, then upsert;
  unknown users stored as NULL). Without `block_doc` they're ignored, so a state-only store
  never touches attribution and no store is added for it (no revision churn). An edit of a
  block `block_doc` doesn't have is left out with a warning, never a 400: attribution must not
  block a content store.
- Read: `GET /posts/:id/block-edits` (content roles, `canReadPost`) → `{"<block_id>": {user:
  {id, username, full_name, avatar} | null, edited_at}}`, `no-store`. Listed in
  `route_auth_test.go`'s `blockEditRoutes` (GET only, never public). Nothing in versions,
  duplicates, templates or `/public`.
- Tests: `db/sqlc/post_block_edit_test.go` (upsert, prune, state-only, rollback, SET NULL),
  `post_block_edits_test.go` (real DB: stored through the internal PUT, every role, not public)
  and `TestPutInternalPostCollab`'s `BlockEdits` cases.

## Mentions, content links and date reminders (#320, `000050`, `inline_nodes.go`, `mentions.go`, `mention_notifications.go`, `reminders.go`)

- **Inline nodes in a text block's pm** (`mention` {userId, label}, `contentLink` {postId, label},
  `dateChip` {date, time, reminder}; rules in `web/gl-admin/lib/blocks-spec/inlineNodes.ts`).
  The sanitizer (`sanitizePMNode` → `sanitizeInlineNode`) makes each an allowlist of normalized
  attrs; a mention or link without a valid id becomes its label as text, a chip without a valid
  day is dropped, a stored `href` never survives. `inlineNodeVectors.json` (web) is shared with
  `TestInlineNodeVectors`.
- **Public API (`publicizeInlineNodes`):** every `/public` response that carries a published block
  doc (`publicPostView`, so the post, slug and front page; `/public/posts/:id/blocks`; the type,
  author and term lists through `publicizePostResponses`) rewrites them in place, one lookup each
  for all docs: a mention → `{label}` = the member's **current** name (else the stored label, else
  "a former member"), a link → `{label, href}` with the target's current path (`postHref`, the
  site's URL structure and published category) **only while the target is published in a public,
  active type** (a draft, the trash or a private type: `{label}`, which the site renders as text),
  a chip → `{date, time}`. A renamed mention's stored `@label` in the block's plain `text`
  (excerpts, meta descriptions) is replaced with the current name too. No user id, post id or email leaves through them
  (`TestPublicInlineNodesWithoutIDsOrEmails` checks every route). A new `/public` route that
  returns published blocks must call it.
- **@ menu routes** (content roles, contributors included, public fields only, never an email):
  `GET /mentions/people?q=` (content-role members by name/username, 5) and `?ids=` (≤100, the
  editor's current names; content roles only too), `GET /mentions/content?q=` (what the caller may read, `canReadPost` via
  `viewer_id`, never trashed, latest edited first, 5).
- **Mention emails** (`mention_notifications.go`): only after a collab store that writes
  `block_doc`. `collabInlineNodes` reads one entry per mentioned member (preferring a block this
  store changed, with its `block_edits` user as who typed it), and `StorePostCollabTx` records
  them in **`post_mention_notifications` (PK post + member)** in the store's transaction,
  returning only new rows. Decision: **one email per member per post**, not per block: a split or
  paste gives the text a new block id and would mail again. No email for: a mention nobody typed in
  that store (a duplicate's or template's content), yourself, a trashed post, and **a member who
  can't read the post (decision: no notification at all**, not "you were mentioned in a post you
  can't see", which would still reveal the post, its author and timing); the row stays
  `emailed=false`, so publishing later sends nothing late. ≤25 emails per store. Template `mention`
  (title + admin link, never content), after the response (`runInBackground`).
- **Reminders** (`reminders.go`): `StorePostCollabTx` keeps `post_reminders` in step with the
  working copy, a chip being its **block, day and time** (UNIQUE), never the instant (`DeleteStalePostReminders`
  drops pending rows whose chip is gone or moved; `RetimePostReminders` moves `remind_at` when the
  site's zone changed;
  `AddPostReminders` adds chips with an owner, the block's `block_edits` user, and a time still
  ahead, in the site's zone: `reminderInstant`, a DST gap fires when it ends). The store reads the
  site's zone only for a doc with a reminder. **The #147 scheduler sends them**
  (`RunScheduledPublishing` → `sendDueReminders`, after publishes and updates): `ClaimDueReminders`
  (`FOR UPDATE SKIP LOCKED`, the lease is the fencing token), `canReadPost` checked at send time
  (else `skipped`), retries with #147's backoff up to 5 attempts (`failed`), `sent` rows never fire
  again. At most 10 per round (`reminderMaxPerRound`): the sends share the publishing loop. Template `reminder`.
- Tests: `inline_nodes_test.go` (vectors, sanitizer, extraction, DST), `mentions_db_test.go` (real
  DB: once per member and post, no leak, self/unattributed/trash, the public routes, the menu routes,
  reminders kept in step and sent once, skipped without access), `mailer` `TestMentionAndReminderTemplates`.

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
- **Plugin blocks (#452):** `plugin:<slug>/<block>` is the same kind of block
  (`isExtensionBlockType`, the web's predicate of the same name): the manifest accepts both
  namespaces, an installed one is validated exactly like a theme block, one not in the
  manifest is kept as is. `TestPluginBlocks`.

## Plugin registry (#455, `000054`, `plugins_*.go`, design `docs/design/plugin-system.md` 2–4)

- A plugin is `web/plugins/<slug>/` with a `plugin.json` (`web/plugins/README.md`). The image
  ships it like `web/themes` (`Dockerfile`, `.dockerignore` `!web/plugins`). Installing = shipping
  it in the image. A plugin is trusted code; capabilities are declared and shown, not enforced.
- **One validator** (`ParsePluginManifest`, `plugins_manifest.go`): checks in a fixed order, first
  problem with a field path (`settings.x.default`, `server.hooks[0].event`); unknown fields refused
  at every level; `id` = directory name, `enabled` reserved (it's `GET /plugins/enabled`). Its
  twin `web/gl-admin/lib/plugins/manifest.ts` shares `pluginManifestVectors.json`
  (`TestPluginManifestVectors`, `manifest.test.ts`), and both suites validate every repository
  plugin. Change a rule on both sides and add a vector. `PluginAPIMin`/`Max` = `PLUGIN_API` (tested).
- **`plugins` table:** numeric `id` (activity's `object_id`), `slug`, manifest fields, `manifest`
  (normalized JSON), `content_hash` (SHA-256 over the files, `pluginContentHash`: the future
  signature's input), `status` installed | missing | incompatible, `enabled` (+ `enabled_at`,
  `enabled_by` SET NULL). Settings stay in `extension_settings` (#457).
- **Startup scan** (`ScanPluginsDirectory` + `SyncPluginsToDatabase` in `themes_scanner.go`,
  outside test mode): **never deletes**. New → inserted disabled (`incompatible` outside the
  plugin_api range). Gone → `missing`, keeps `enabled` and settings; back → restored as it was.
  A known plugin whose `plugin.json` stops validating → `incompatible` with its last valid
  manifest (`MarkPluginInvalid`); a never-valid one writes nothing; a symlinked directory is
  skipped with a warning. No `web/plugins` directory →
  no sync (nothing is marked missing). Every write is one conditional statement that returns a
  row only when it changed something (`plugins.sql`), so replicas scanning together record each
  change once (tested with four concurrent syncs).
- **Routes** (`plugins_routes.go`): `GET /plugins`, `GET /plugins/:slug` (with `manifest`), `POST
  /plugins/:slug/enable|disable` are `requireSiteAdmin`; `GET /plugins/enabled` (content roles)
  → `{plugins: [slug]}`, enabled **and** installed only. Enable: 409 `plugin_missing` /
  `plugin_incompatible` (`plugin_changed` after a lost race); enabling an enabled one (or disabling a disabled one) is 200 with no
  event. Disable works in any status. Responses carry `active` (enabled and installed) and, for
  incompatible, `incompatible_reason` (`plugin_api` | `invalid_manifest`). They change no schema
  (design 5.3).
- **Activity** (`object_type` `plugin`, admin-only in the feed, which joins `plugin: {id, slug,
  name}`): `plugin_enabled`/`plugin_disabled` (the admin, `{version}`); the scan as the system:
  `plugin_installed` (`{version, status}`, `restored: true` on a return), `plugin_updated`
  (versions and statuses, `reason: invalid_manifest`), `plugin_missing`.
- **Content blocks (#456, `plugin_blocks.go`):** the scan reads each declared block's
  `blocks/<Name>/block.json` (`ValidatePluginBlockJSON`, twin of the web's `blockJson.ts`,
  `pluginBlockVectors.json`; type = `plugin:<slug>/<name lowercased>`) for a plugin whose plugin_api
  is core's; a missing, invalid or undeclared one makes the plugin invalid (`incompatible`, like a
  bad plugin.json). `NewServer` merges the loaded plugins' specs into `server.themeBlocks`
  (`mergePluginBlockSpecs`), so `applyThemeBlocks` validates them: installed, whatever is enabled.
  **`GET /plugins/:slug/usage`** (admin; any status, unknown slug 404) → `{slug, count, posts:
  [{id, title, post_type, post_status, in_working_copy, in_published, changed_at}], truncated}`:
  `ListPostsUsingPluginBlocks` (jsonpath `$.blocks.*.** ? (@.type starts with "plugin:<slug>/")`
  over `block_doc` and `published_block_doc`, so a block in a quote's pm counts; trash included;
  ≤100 rows, `count` all). The Plugins page's disable confirmation reads `count`.
- Tests: `plugins_manifest_test.go` (vectors, hash, scan), `plugins_test.go` (routes, roles,
  races on a mock), `plugins_sync_test.go` (sync decisions on an in-memory table),
  `plugins_db_test.go` (the acceptance list against the real database). The scan is global, so
  DB tests sync through `syncPlugins` with every row that isn't theirs kept present (the local
  test database may be the dev stack's), and plugin tests stay out of `db/sqlc`.
- **Settings (#457, `plugins_settings.go`, design section 6):** rows in `extension_settings`
  keyed `plugin:<slug>:<name>`, `extension_type` `plugin`, `extension_id` the slug, through
  admin-only routes only (the public `/extension-settings` never serves them, #451). `GET
  /plugins/:slug/settings` (any status) → `{fields: [{name, ...spec}] sorted by name, values}`:
  stored values that are declared and still pass the manifest's rules (an upgrade can narrow a
  field; such a row reads as unset), and every `"secret": true` field as `{"set": bool}`, never
  the value (stored in the clear for Beta: backups hold it). `PUT {values: {name: value|null}}`
  (installed only, else 409 `plugin_missing`/`plugin_incompatible`): named fields only, null
  clears (the default applies), a field left out is kept (how the form leaves a secret alone);
  each value goes through `themeAttrProblem` plus a 10,000-character cap on a string without
  `maxLength`; any problem → 400 `invalid_plugin_settings` with `fields`, nothing written; the
  writes are one transaction (`SetPluginSettingsTx`). Activity `plugin_settings_updated`
  `{fields}`: the names that changed, never values; nothing when nothing changed. `DELETE`
  ("Delete plugin data", any status) removes this plugin's rows only (`DeletePluginSettings`),
  activity `plugin_data_deleted` `{count}` when it removed any. Tests: `plugins_settings_test.go`
  (mock: validation, secrets, the changed-field list) and `plugins_settings_db_test.go` (real DB:
  roles, keys, secrets never returned, payloads, another plugin's and a theme's rows kept).

## Plugin server hooks (#458, `000055`, `plugin_hooks.go`, `plugin_host.go`, design 7.1–7.6, 7.8)

- **Events come from one trigger on `posts`** (`posts_plugin_events`, `golive_post_plugin_events`),
  never from Go: `post.saved` (INSERT or `changed_at` moved), `post.published` (000044's condition
  plus an INSERT as published; actor = the new version's `created_by`, NULL through PUT/POST),
  `post.unpublished`, `post.trashed`, `post.restored`, `post.deleted` (carries `post_type`). So every
  publish path (button, bulk, scheduler, scheduled update, `post_status` through PUT or POST) writes
  one, in its own transaction, and a new path needs nothing. The insert is filtered by
  `golive_plugin_event_subscribed` (an enabled, installed plugin's manifest declares the hook): **no
  subscriber, no row**. `ON CONFLICT DO NOTHING` against `plugin_events_one_pending_save` (one
  unfanned `post.saved` per post) and `plugin_events_one_publish` (one `post.published` per post and
  `txid`). Settings saves and body stores are the same `post.saved` (section 11's default).
- **Outbox:** `plugin_events` (no FK on `post_id`; `data` ids and small facts) → `plugin_hook_runs`
  (per event and plugin; `post_id`/`event` copied for the ordering index; `next_attempt_at` is the
  due time and, while running, the lease = fencing token; `finished_at` for retention).
- **`RunPluginHooks`** (main.go, every replica, `PLUGIN_HOOKS_INTERVAL` 1s, 0 = off, idles 30s
  while no plugin with hooks is active here): `FanOutPluginEvents` (one statement, a
  `pg_try_advisory_xact_lock` so one replica fans out, in id order; runs only for plugins subscribed
  **now**; a `post.saved` gets no run if that plugin already has a pending save run for the post; an
  event with no run is deleted) → `SkipInactivePluginHookRuns` (disabled/missing/incompatible, or a hook an upgrade dropped; every 30s) →
  per plugin registered in this build, `ClaimDuePluginHookRuns` up to its free slots (2 per plugin,
  8 overall, held until the hook goroutine returns), `FOR UPDATE SKIP LOCKED`, 2-minute lease, never
  while an earlier run of the same plugin and post is unfinished → each hook on its own goroutine
  with `timeout_ms` (10s default, 30s max) and recovery → `RecordPluginHookRunDone` /
  `RecordPluginHookRunFailure` under the claim (scheduler backoff, 8 attempts, then `failed`;
  `last_error` ≤1000) and `plugin_hook_failed` (system actor, one per plugin per 10 min, a final failure always). Shutdown
  waits for runs in flight. Prune hourly: done/skipped 7 days, failed 30, spent events.
- **Go contract:** `pluginsdk/` (imports only the standard library; tested): `Event`, `Host`
  (`Settings` = manifest defaults + `extension_settings` keys `plugin:<slug>:<field>`; `Posts`/
  `Media`/`Users` nil unless declared; `Log`), `Plugin{Observers, BeforePublish}`, `Register` from
  `init()`. Readers are read-only: no hook writes `block_doc`
  (rule 11). `server.pluginRegistry` = `pluginsdk.Registered()`, filled by
  **`api/plugins_gen.go`** (blank imports of `web/plugins/*/server`, `go run ./cmd/gen-plugins`,
  committed, `--check` in CI's Go lint job). The scan compares it with each `plugin.json`
  (`pluginHooksMismatch`, the guard included): a difference either way → `incompatible`, reason
  `hooks` in the response.
- Tests: `plugin_hooks_test.go` (mismatch, timeouts, slots, panics, Host on a mock) and
  `plugin_hooks_db_test.go` (real DB: no subscriber writes nothing; one `post.published` per publish
  path in the version's transaction, a rollback writes none; order and retry; giving up; the lease;
  panics and hung hooks; skips; save backlog; pruning; drift; the loop). Dispatcher tests loop
  `roundsUntil` their own run: on a shared database other tests' events reach the same plugin first.

## Publish guards (#459, `plugin_guards.go`, design 7.3, 7.7)

- A guard is `pluginsdk.Plugin.BeforePublish` (`Guard`: `PublishCandidate{PostID, PostType, ActorID,
  Via, BlockDoc}` → `Decision{Deny, Reason}`), declared `{"event": "post.before_publish", "on_error",
  "priority"}`. `HookEvents` includes it (the mismatch check), `ObserverEvents` doesn't (the
  dispatcher claims observers only).
- **`runPublishGuards` runs before the transaction on every publishing path, never inside
  `PublishPostTx`** (no plugin code under the row lock): `publishPostByID` (button, bulk) and
  `publishScheduledPost` after the flush, on `block_doc`; `applyScheduledUpdate` on the frozen
  snapshot (`GetScheduledUpdateSnapshot`, fenced by the claim; no row = changed, skipped); `POST
  /posts` and `PUT /posts/:id` when `post_status` becomes `published` (`checkStatusPublishGuards`,
  before any write; no version, so the candidate is the current published body or the empty doc,
  `PostID` 0 on create; saving a published post again isn't asked). A new path that publishes must
  call it too.
- Which: `ListHookPlugins` rows (enabled, installed) whose code is registered with a guard and
  matches plugin.json, sorted `(priority, slug)`, sequential, first deny wins. No guard code in the
  build → no read at all. 3s each (`pluginGuardTimeout`), 5s total (`pluginGuardBudget`), through
  the context; a guard ignoring it isn't waited for. Error, panic, timeout or budget used up →
  allow (logged `plugin_guard_failed`) unless `on_error: "deny"`. Each guard gets its own copy of
  the body. The reason is made one plain line, ≤280 characters, and never logged.
- Answers: 409 `{code: plugin_refused, error: <reason>}` (`pluginRefusal.actionError`; bulk: the
  per-post result), 503 when the guards can't be listed (nothing published). The scheduler records
  `plugin_refused` through `recordScheduledPublishFailure` / `recordScheduledUpdateFailure`
  (`schedule_failure` / `scheduled_update.failure`) and retries with the backoff; the reason text
  isn't stored (`publish_error` is a code).
- Tests: `plugin_guards_test.go` (mock: which and in what order, first deny, error/panic/timeout/hang
  × on_error, the total budget, the candidate copy) and `plugin_guards_db_test.go` (real DB: each
  path refused then allowed, the guard never runs while the post is locked, only enabled plugins,
  on_error on the button and the scheduler).

## Plugins and reader comments (#530, `000066`, `plugin_comment_guards.go`, reader-comments.md 14)

- **Events:** the `reader_comments_plugin_events` trigger (`golive_reader_comment_plugin_events`)
  writes to #458's outbox like the posts trigger, filtered by `golive_plugin_event_subscribed` (**no
  subscriber, no row**): `comment.created` (an INSERT that isn't unconfirmed, or status leaving
  unconfirmed), `comment.approved`, `comment.unapproved` (approved → pending), `comment.spammed`,
  `comment.trashed`, `comment.deleted` (DELETE or tombstone; not an unconfirmed comment, not a
  tombstone's later DELETE, not the cascade of a post deleted for good: `post.deleted` stands for
  it). `post_id` is the comment's post (ordering per plugin and post). **`data` is ids only**:
  `comment_id`, `root_id`, `status` (the old one on a delete), `previous_status`, `by_member`; never
  a name, text or address. `actor_id`: the member on `comment.created`, the moderator when
  `moderated_at` moved. `pluginsdk.ObserverEvents` lists them, so webhooks deliver them unchanged.
- **Capabilities:** `comments:read` → `Host.Comments()` (`pluginCommentReader`: name, text, status,
  post, ids; never the commenter, address or hashes; an unconfirmed comment is `ErrNotFound`).
  `comments:private` is required by the validator for a `comment.before_create` guard (both twins,
  `pluginManifestVectors.json`).
- **The guard:** `pluginsdk.Plugin.BeforeCommentCreate`, declared `{event: comment.before_create,
  on_error: allow|hold, priority}` (`pluginGuardOnError` holds each guard's on_error words; no
  `timeout_ms`; never a webhook; `gen-plugins` refuses any guard without server code).
  `runCommentGuards`: no guard code in the build → nothing read; `guardPlugins` (shared with
  publish guards: enabled, registered, matching plugin.json, `(priority, slug)`), sequential, **the
  first spam wins**, a hold is kept while later guards run, 2s each (`commentGuardTimeout`) and 3s
  total (`commentGuardBudget`), calls capped per plugin (`commentGuardCalls`). Error, panic, timeout
  or budget used up → allow unless `on_error: hold` ("<name> couldn't check this comment."). Any
  verdict but hold or spam is allow (**a guard can't approve**). Listing the guards fails → hold.
  The reason becomes `held_detail` "<name>: <reason>" (≤200). Logs: plugin, post id, verdict and
  duration only; a plugin's error text is logged with the candidate's values blanked
  (`redactCandidate`).
- Tests: `plugin_comment_guards_test.go` (mock: order, spam over hold, verdicts, failures ×
  on_error, budget, caps, redaction) and `plugin_comment_events_db_test.go` (real DB: no
  subscriber, every event and its data, observers and `Host.Comments`, the guard on the real write
  path keyed and keyless, the budget).

## Plugin webhooks (#460, `plugin_webhooks.go`, `outbound_http.go`, design 7.9)

- **Declared in plugin.json:** `server.webhook {url_setting, secret_setting}` (a string setting; a
  different `"secret": true` string setting), `network` required, at least one hook, never
  `post.before_publish` (validator + vectors on both sides). Such a plugin has **no Go code**:
  `pluginHooksMismatch` makes registered code `incompatible` and `gen-plugins` refuses it.
- **Not a second runner.** `activePlugins` builds the plugin's `pluginsdk.Plugin` itself
  (`server.webhookPlugin`: one observer per hook, `webhookSender.observer`), so fan-out, claim,
  lease, order, `timeout_ms`, slots, backoff, 8 attempts, `plugin_hook_failed` and skipping are
  #458's. 2xx = done; any other status, a 3xx (never followed), a timeout, a refused address, or a
  URL/secret not set (secret ≥ 16 characters) = a failed attempt. No migration.
- **Signing** is `pluginsdk.SignWebhook`: HMAC-SHA256 over `"<unix ts>.<raw body>"`, headers
  `GoLive-Event-Id` (the idempotency key), `GoLive-Event`, `GoLive-Timestamp`, `GoLive-Signature:
  v1=<hex>`; body `pluginsdk.WebhookPayload`. `VerifyWebhook` = the receiver's side (5-minute
  window, any `v1` in a comma list). Rotation = saving a new secret setting.
- **SSRF:** `outbound_http.go` is the one guard, shared with `POST /embeds/resolve` and `POST /media/import` (#29): the dialer's
  `Control` refuses every non-public range (`nonPublicPrefixes`: private, loopback, link-local,
  CGNAT, multicast, reserved, documentation, metadata, NAT64/6to4/Teredo/IPv4-compatible; mapped
  addresses unmapped) **at connect time**, so DNS answers and rebinding are covered; no proxy, no
  keep-alives. Webhooks add: https only, no userinfo, ≤ 2048 characters, a literal IP must be
  public (`urlProblem`, also on `PUT /plugins/:slug/settings`), headers ≤ 16 KB, body never read.
  `PLUGIN_WEBHOOKS_ALLOW_INSECURE` (http + private, for a local receiver) is refused by
  `LoadConfig`/`NewServer` outside debug mode.
- **No secret anywhere:** every failure is a fixed `webhookFailure` message (Go's client errors hold
  the URL, which may carry a token), so logs, `last_error` and activity never hold the URL or the
  secret; the secret setting is write-only (#457).
- Tests: `plugin_webhooks_test.go` (signing, failures, the policy incl. a DNS answer and redirects,
  the address table, settings checks) and `plugin_webhooks_db_test.go` (real DB through the
  dispatcher: signed at-least-once delivery and retry, refused target, timeout, disabled plugin, no
  secret in logs/activity/`last_error`/GET settings). Local receivers need the dev allowance
  (`newWebhookSender(true, pool)`); the refusals use the real policy.

## Public read cache (#185, `cache/`, `public_cache.go`)

- **`cache/`**: `Cache` (Get → `ErrMiss`, Set, SetNX, Delete, Enabled, Ping, Close), the
  Valkey/Redis client (go-redis v9; 500 ms dial, 250 ms reads, one dial retry, its own log
  silenced) and `Noop`. `REDIS_URL` (and `_FILE`) is optional: unset = `Noop`, so handler
  tests and plain runs need nothing; a bad URL fails `NewServer`. `cache.Namespace`: every key
  carries a random generation (`<name>:gen`, no TTL); `Purge` sets a new one. Take the key
  (generation) **before** reading Postgres, so a read that raced a write stores under the old
  generation.
- **What's cached** (`publicCacheRoutes`, `cachePublicResponses` on the `/public` and
  `/api/v1` groups): whole anonymous GET responses (status, Content-Type, body) of the public
  post, list, author, term and menu reads, `/public/front-page` and the site config the web
  reads per request (settings, active theme, extension settings, post types, taxonomy types
  and terms). 200s, plus 404s where the route says (`notFound`: front page, menus). Never with
  an `Authorization` header, a `Set-Cookie` or a `private`/`no-store` directive (any case or form, #495:
  `cacheControlForbidsStore`), over 2 MiB, or search/redirects.
  Key = method + escaped path + sorted query (hashed past 512 bytes); TTL 5 minutes;
  concurrent misses share one run (singleflight). `X-Cache: HIT|MISS|BYPASS`. A replayed 404
  goes through `requestIDErrorWriter`, so it carries the current request id. A new cached
  route must be public (`TestPublicCacheRoutesArePublic`) and must not read a header, cookie
  or the clock.
- **Purges are global and after commit**: `purgePublicCacheAfterWrite` on `/api/v1` purges
  after any request to a route in `publicCachePurgeRoutes` that didn't answer 4xx; the
  scheduler purges after a scheduled publish or update; `NewServer` purges at startup (theme
  scan, seed, a restored DB); `main backfill-variants` after generating. **Every mutating
  route must be in `publicCachePurgeRoutes` or `publicCacheNoPurgeRoutes`**
  (`TestMutatingRoutesDeclarePublicCachePurge` walks both routers). Snapshotted fields (SEO,
  template, byline, restore and restore-settings, html snippets) don't purge: they reach the site on
  Update, which does. `publicCachePostDetailRoutes` (PUT `/posts/:id`, meta, featured image,
  media links) purge only if that post was or is published (one `GetPost` before and after),
  so the editor's debounced saves of a draft don't empty the cache. Logs use
  `server.requestLog(c)` (the job's logger in the scheduler).
- **Failures never fail a request**: a cache error is a BYPASS read from Postgres, logged once
  a minute; then reads skip Valkey for 5 s, and the first read after that purges before using
  anything (a purge may have been missed). A failed purge is logged at error level.
- Tests: `cache/cache_test.go` (miniredis), `public_cache_test.go` (mock store: hit/miss,
  keys, bypass, what isn't stored, recovery, singleflight), `public_cache_routes_test.go`
  (route audits), `public_cache_db_test.go` (real DB: every publish path, settings, menus,
  drafts never cached, a failed purge doesn't fail the write).

## Global styles and site design publish (#485, `000056`, `global_styles.go`, `site_design_*.go`, design `docs/design/theme-builder.md` 5.1, 6, 8.2, 12)

- **Tables:** `global_styles` (one row per theme slug, no FK: a removed theme keeps its
  design; `draft` + `draft_revision`, `published` + `published_version_id`),
  `global_style_versions` (per publish that changed styles, `version_no` per theme) and
  `site_design_releases` (one per publish; `summary` = group names and counts, never
  values). #490/#492 add templates and parts to the same release. The draft is **never**
  in `theme_settings` or `extension_settings` (both public).
- **Declared tokens** come from `web/themes/tokens.manifest.json` (generated with the block
  manifest by `npm run themes:manifest` from each `theme.config.ts`: tokens with their
  defaults, `fontOptions`, `supports.globalStyles`; `LoadThemeTokenManifest` in `NewServer`,
  missing = warning and no theme supports global styles, invalid = startup error). Handler
  tests get an empty one; set `server.themeTokens` (`fixtureThemeTokens`).
- **Grammar (`ValidateGlobalStyles`, 6.3):** colours `#rrggbb` (lowercased); lengths a
  number with px/rem/em/%/vw or `clamp(<len>, <len or len + len>, <len>)` (spaces only,
  respaced on write); line heights a JSON number 1–2.5; fonts a theme `fontOptions` id or
  a core system id (`system-sans|serif|mono`). Only keys the theme declares, at paths core
  can style; anything else is 400 `unknown_token` (never dropped). Order rules on the merged
  values when comparable (same plain unit): `contentWidth ≤ wideWidth ≤ container`, spacing
  steps non-decreasing (400 `token_order`). Errors name the first path in sorted key order.
  **`web/src/lib/globalStyleVectors.json` pins Go and the web's `globalStyles.ts`**: same
  codes, paths, messages, contrast pairs and groups (`TestGlobalStyleVectors`). Change both
  with the vectors.
- **Routes** (all `requireSiteAdmin`, `siteDesignRoutes` in `route_auth_test.go`):
  `GET /site-design/global-styles` (declared tokens + defaults, font options, draft,
  revision, published, failing contrast pairs); `PUT` (`{styles, base_revision}`: the whole
  draft; stale → 409 `styles_changed` with `current`; same draft → no new revision; theme
  not in the manifest or without `supports.globalStyles` → 409
  `global_styles_unsupported`, except `{}`, so a stale draft can be cleared; throttled `global_styles_updated` on the theme id with
  `groups`); `POST /site-design/publish` (`{confirm_contrast}`): nothing changed → 409
  `nothing_to_publish`; the draft re-validated (a token the theme stopped declaring → 409
  `styles_invalid`, `reason`, `path`); **contrast is a warning**: failing pairs → 409
  `contrast_unconfirmed` with `pairs`, unless `confirm_contrast: true`; then the styles
  part of `PublishSiteDesignTx` (row `FOR UPDATE`, revision re-checked → `ErrGlobalStylesChanged`
  = 409 `styles_changed`), the purge after commit (`publicCachePurgeRoutes`) and
  `site_design_published` on the release id. #492 generalized this route to templates and
  parts (below); the body and a styles-only answer are unchanged. Activity object type `site_design` is admin-only in the feed.
- **Contrast pairs** (`contrastPairs`) are core's `CONTRAST_PAIRS`, the list the default
  theme's `tokens.test.ts` checks, plus each block colour as text on background/surface/
  surface2 and the text on its fill; pairs naming an undeclared colour are skipped.
- **Public read:** only the *published* override, as `global_styles` on `GET /themes/active`
  (`GetActiveThemeWithSettings` joins `global_styles.published`; cached, purged by publish
  and theme activation). `TestDraftGlobalStylesNeverPublic` walks every `/public` and
  `/themes` GET route, signed in and not, for a draft marker.

## Design preview (#486, `site_design_preview.go`, `token/design_preview.go`, design 8.3, 12)

- `POST /site-design/preview` (admin) → `{token, theme, expires_at}`: v4.public, signed with
  the access key (footer KID, so rotation covers it), audience `golive.design-preview`,
  `token_type: design_preview`, `user_id` and `theme` claims, 15 minutes
  (`designPreviewTTL`). `VerifyToken` rejects it and `VerifyDesignPreviewToken` rejects access
  tokens and collab tickets. The web keeps it in an HttpOnly cookie (`POST /gl-preview`).
- **`GET /site-design/draft` is the named exception to `requireSiteAdmin`**: registered
  outside the admin group, its bearer is a preview token, never an access token (401). It
  checks the token (401, `preview_expired`), then the user's row: gone or **not an admin any
  more → 403** (a demotion ends previews at once), a password change since → 401; then the
  active theme must be the token's (409 `preview_theme_inactive`). 200 =
  `DesignDraftResponse{theme, global_styles (the draft, {} when none), expires_at}`: one key per
  kind of design item. **`?slugs=` (#493)** adds `template`, `parts` and `menus` in the public resolve's shape, from
  the **working copies** (`workingSiteDesignOverrides`: every `custom` row's `block_doc`; a reset row is left out, so
  the theme's default renders, as after the next publish), through `resolveSiteDesign`, the resolver the public route
  uses on the published copies (400 `invalid_slugs` as there). The web's previewed requests read templates from it.
- Both answer `Cache-Control: private, no-store`, read nothing from the public cache and aren't
  cached (`publicCacheRoutes` never lists them; the preview POST is in `publicCacheNoPurgeRoutes`).
  The token is never logged (`TestDesignPreviewTokenNeverLogged`). Listed in `siteDesignRoutes`
  (`route_auth_test.go`).

## Templates and parts (#490, `000058`, `site_templates.go`, `internal_handlers_site_templates.go`, `theme_block_templates.go`, `sitedesign/`, design `docs/design/theme-builder.md` 5, 7)

- **Tables:** `site_templates` (one row per theme slug, kind `template` | `part` and slug; `theme_slug` has no FK, a
  removed theme keeps its rows; slug `^[a-z0-9][a-z0-9_-]{0,79}$`, so `single-case_study` stores; `block_doc` +
  `block_revision`, which starts at **1** like a post's: the collab server sends `base_revision` only when positive and a
  state-only store needs one; `working_state`, `source` + `source_hash`, `published_block_doc` +
  `published_version_id`), `site_template_ydoc_state` (as `post_ydoc_state`: state, a UUID epoch, the revision it was
  stored at) and `site_template_versions` (per publish, under `site_design_releases`; written by #492).
- **A second collab document kind, `template-<id>`** (parts share the prefix): `collabDocRef` /
  `collabDocNamePattern` (the collab server's `isCollabDocName` must match). `GET /internal/site-templates/:id/collab`
  is the #280 load plus `doc_kind` (the row's kind) with the same revision guard; `PUT` is the store without
  `block_edits` (an unknown field: 400), `prepareForStoreAs` with the row's kind (a part holding a `template_part`: 400),
  then `StoreSiteTemplateCollabTx` (lock, `block_doc` + revision+1 + `changed_at` only with a `block_doc`, the state at
  the new revision, a throttled `site_template_edited`; 409 behind, 404 gone). No media links, mentions, reminders,
  comments or plugin events: those are posts'.
- **Admins only, everywhere:** `POST /collab/tickets` for `template-<id>` is admins' (403; 404 for a missing row);
  `/internal/users/:id/access` answers `can_edit` = `isSiteAdmin` for a template (`templateDocAccess`), which the
  collab server turns into a denial at connect and a close on a re-check (never read-only). A role change already calls
  `recheckCollabUser`, which covers template connections.
- **`POST /site-design/templates {kind, slug, from: theme|starter|blank, title?}`** (`requireSiteAdmin`): a row for the
  active theme. `theme` copies the shipped default from the theme's config (404 `no_theme_default`), `starter` core's
  starter (`sitedesign.Starter`: `parts/header`, `parts/footer`, and for any template slug its own, a prefix's, an
  alias's or `archive`; 404 `no_starter`), `blank` an empty doc. Copies get fresh block ids and `prepareForStoreAs` (400
  `template_invalid`). 409 `template_exists` with the row's `id`; 400 `invalid_slug` / `invalid_title`. No Yjs
  state is made: the collab server seeds on first open (rule 11). Activity `site_template_created` (`kind`, `slug`,
  `source`; object `site_design`, the row's id). Not public; no purge.
- **Theme scan (5.7):** `ScanThemesDirectory` reads `templates/<slug>.json` and `parts/<slug>.json`
  (`{title, doc}`, `sitedesign.ParseFile`: strict, ≤ 1 MiB, ≤ 200 per kind); `applyThemeBlockTemplates` (after the
  theme **and plugin** block manifests load, so `NewServer` now scans plugins first) validates each with its kind's rules
  and stores the valid ones as `config.block_templates` / `config.block_parts` (slug → `{title, doc, hash}`). Invalid
  files are logged and left out; a slug that also has a code layout at its rank logs that the block template wins.
- `flushCollabTemplate` (`template-<id>`) is what #492's publish calls.
- **The public resolve (#491, `site_templates_resolve.go`, design 3.3, 4.2):** `GET /public/site-templates/resolve?theme=
  <slug>&slugs=<a,b>` (1–8 distinct slugs in rank order; 400 `invalid_slugs`/`invalid_theme`; a theme that isn't the
  active one is 404 `theme_inactive`). One read, `ListPublishedSiteTemplatesForResolve` (**published copies only**: a
  working copy, a reset row and a never-published one aren't the site's). 200 `{theme, template, parts, menus}`:
  `template` is the first slug with a published override, else a block template the theme ships (`config.block_templates`),
  with its `rank`, or null; `parts` holds the parts it places resolved override → theme (`config.block_parts`) → core's
  starter (`sitedesign.Starter`, through `normalizeSiteTemplateDoc` like a Customize copy), plus **every published
  override part** (a code layout's `<TemplatePart>`); `menus` the menus its and those parts' navigation blocks name by id
  (as `/public/menus/:location` serves one, at most 16; deleted or failed = absent). Every doc gets `attachBlockMedia`
  and `publicizeBlockDocs`. Cached in `publicCacheRoutes` (the key has the theme and slugs); publish, theme activation,
  menu, media and settings writes purge it. **Core's starters are the default theme's templates and parts**
  (#498, design 5.7): `api/sitedesign/starters/` is a byte-for-byte copy of `web/themes/default/{templates,parts}`
  (`go generate ./api/sitedesign`, `sync_starters.go`; `TestStartersAreTheDefaultThemes` fails on drift), embedded so
  the API has them without `web/themes`. `custom` starts from `page`, `front-page` from `home` (`starterAliases`), a
  slug nothing matches from `archive`. `codeLayoutForSlug` (the scan's "block template wins" log) follows the web's
  ranks: `taxonomy` is `layouts/term`'s. `TestDefaultThemeShipsBlockTemplates` and
  `TestDefaultThemeCustomizeStartsFromItsTemplates` scan the real default theme: every route's template validates, and
  Customize / Start over start from it (other themes from the same file, as a starter). Tests: `site_templates_resolve_test.go`,
  `site_templates_resolve_db_test.go`, `sitedesign_test.go`.
- Tests: `site_templates_test.go` (mock: names, access, tickets, the internal routes, Customize), `site_templates_db_test.go`
  (real DB through the routes), `theme_block_templates_test.go` (the scan), `sitedesign/sitedesign_test.go`,
  `db/sqlc/site_template_collab_tx_test.go` (the transaction and 000058's constraints).

## Publish site design, history, reset and restore (#492, `site_design_publish.go`, `site_templates_manage.go`, `site_design_history.go`, `db/sqlc/site_design_tx.go`, design `docs/design/theme-builder.md` 5.3, 8, 9, 12)

- **One publish for everything** (`POST /site-design/publish {confirm_contrast}`, the only "Publish site
  design" route; #485's styles-only publish, generalized, same body and keys). It publishes every item of the
  **active theme** with unpublished changes (`siteTemplateChange`: a custom row whose `block_doc` differs from
  `published_block_doc` by JSON value, or was never published → `publish`; a reset row that still has a
  published copy → `reset`; plus the styles when draft ≠ published), in three phases:
  1. **Outside any transaction:** `flushSiteDesign` flushes every *custom* row (a reset row's working copy
     isn't published), up to 4 at a time; any failure → 503 `collab_unavailable` naming the first failed row
     (`id`, `kind`, `slug`), nothing published, a styles-only release included (the issue's rule). Rows are read again, then `validateSiteDesignPlan`: each published working copy re-runs
     `prepareForStoreAs` (a block uninstalled since → `template_invalid`), no **template** is empty
     (`blockDocIsEmpty`: only blank paragraphs, also inside groups and columns; an empty **part** is allowed, a
     site may have no footer), and the `template_part` slugs this publish could break resolve (4.2: a part live
     after it, else the theme's shipped part, else core's starter) → `part_unresolved` with `part`: every slug of
     a template being published, and of an unchanged live template only the parts this release changes (a
     template broken by a theme deploy doesn't block unrelated publishes). All problems at once:
     409 `design_invalid` with `problems`. Then the styles as #485 (`styles_invalid`, `global_styles_unsupported`,
     `contrast_unconfirmed` with `pairs`; only when the styles are in the release).
  2. **`PublishSiteDesignTx`**: styles row `FOR UPDATE` (revision → `ErrGlobalStylesChanged`), then every row of
     the theme `FOR UPDATE` in id order (`LockSiteTemplatesByTheme`) compared with the **stamps** the caller
     validated (`SiteTemplateStamp`: id, `block_revision`, `working_state`, `published_version_id`; a row added,
     deleted or changed → `ErrSiteDesignChanged` = 409 `design_changed`, publish again). One release, a version
     **only for the changed items** (`block_doc` NULL for a reset) and their published copy (a reset publishes
     NULL), the styles' version. **No network call inside.** `PublishedTemplate` is the in-transaction hook per
     published row (`publishedSiteTemplateHook`: #496 syncs `site_template_media`'s published rows there).
  3. **After commit:** the purge (`publicCachePurgeRoutes`; a failed purge is logged, never fails the publish)
     and `site_design_published` on the release (`theme_slug`, `templates`, `parts`, `resets`, `slugs` capped at 8
     as `kind:slug`, `global_styles_groups` and `contrast_failures` when styles were in it). The release's
     `summary` has every item (`templates: [{id, kind, slug, reset}]`) and `global_styles`.
  Response: `release`, `global_styles` (null without styles), `templates` (`{id, kind, slug, title, version_no,
  reset}`, templates first), `styles`.
- **Per item** (all `requireSiteAdmin`, none purges: nothing public changes until publish): `GET
  /site-design/templates` (the active theme's rows **without docs**, with `change`, `has_unpublished_changes`,
  `published_block_doc`, `published_version_no`, `default_changed`, `can_delete`, and `unpublished_changes`, the
  Publish button's count, styles counted once), `GET /templates/:id` (any theme's row). **Reset** `POST
  /templates/:id/reset` / **Keep editing** `.../keep-editing` set `working_state` only, never `block_doc`
  (rule 11); twice is a 200 with no event. **Delete** `DELETE /templates/:id` removes only a row with
  `published_block_doc IS NULL` (`DeleteUnpublishedSiteTemplate`, one statement: a publish that got there first
  wins → 409 `template_published`), versions and Yjs state cascade, then `recheckCollabTemplate` closes its
  editors. **Start over** `GET /templates/:id/default?from=` (the theme's shipped default, else the starter,
  fresh block ids; 404 `no_default`, also for another theme's row) and, after the editor applied it, `POST
  .../start-over {from?}` (source + the server's hash, custom again). **Restore** `GET .../versions`, `GET
  .../versions/:no` (`block_doc` null for a reset version), and after the editor restored it (rule 9) `POST
  .../versions/:no/restore` (custom again, so a reset published as NULL comes back on the next publish; a reset
  version → 409 `version_is_reset`). **Discard changes** for a template is the restore of `published_version_no`
  (the web's `templateRestore.ts`); after a published reset it is Reset again; never published → Delete is its discard.
- **History:** `GET /site-design/releases?limit=&before=` (newest first, paged by id, `next_before`; each with
  `items` = its template/part versions and `global_styles_version`, names joined at read time). Styles: `GET
  /global-styles/versions[/:no]`, `POST /global-styles/versions/:no/restore {base_revision}` (validated against
  the theme now → 409 `styles_invalid`; stale → 409 `styles_changed`) and `POST /global-styles/discard
  {base_revision}` (draft = published), both by REST into the draft.
- **Activity** (object `site_design`, admin-only): `site_template_reset`, `_reset_cancelled`, `_deleted` (`kind`,
  `slug`), `_restored` (`version_no`), `_started_over` (`kind`, `slug`, `source`); `global_styles_restored`
  (`version_no`), `global_styles_discarded` (`groups`).
- Tests: `site_design_publish_test.go` (mock: every flush before the transaction and none after, refusals, the
  helpers), `site_design_publish_db_test.go` (real DB through the routes: each acceptance item of #492, history,
  styles restore/discard, the transaction's stamps and hook rollback), the #485 tests in `site_design*_test.go`.
- Tests: `site_templates_test.go` (mock: names, access, tickets, the internal routes, Customize), `site_templates_db_test.go`
  (real DB through the routes), `theme_block_templates_test.go` (the scan), `sitedesign/sitedesign_test.go`,
  `db/sqlc/site_template_collab_tx_test.go` (the transaction and 000058's constraints).

## Site design caching and "Used in" (#495, #496, `000063`, `site_design_cache_db_test.go`, `media_used_in_site.go`, design `docs/design/theme-builder.md` 5.6, 11)

- **Caching (#495) is #185's cache-aside, nothing of its own.** The design's public reads are `GET
  /public/site-templates/resolve` (templates, parts, their media and menus by id) and the published global styles in
  `GET /themes/active`, both in `publicCacheRoutes`. The key is the whole request: the theme and the ranked slugs (the
  route kind *is* its slug list; another order is another key). Everything else they depend on purges, after commit,
  through `publicCachePurgeRoutes`: the design publish (a reset publish too), theme activation, `PUT /settings` (site
  logo, front page), menus, media writes, plugins. The per-item routes (reset, keep editing, start over, version
  restore, styles restore/discard, the collab store) don't purge: they change only working copies, which no public
  read serves; a restore reaches the site with the next publish, which purges. Previews never touch the cache: `GET
  /site-design/draft`'s bearer bypasses it and its `private, no-store` answer can't be stored. Tests (real DB +
  miniredis): `site_design_cache_db_test.go` (each event, the key, the purge seen after commit from another
  connection, a failed purge never fails the publish, preview).
- **`site_template_media` (#496, `000063`):** one row per media block of a template or part per copy (`published`
  false = working copy, true = published), with `block_type`; FKs cascade from the template and the media.
  `StoreSiteTemplateCollabTx` syncs the working copy with every store that writes `block_doc` (`ContentMedia`, from
  `contentMediaUses`; nil = none), `PublishSiteDesignTx`'s hook the published copy (a reset publishes NULL: no rows),
  and `POST /site-design/templates` once after creating a copy with media (logged on failure; the first store syncs
  again). `SyncSiteTemplateMedia` skips ids without a media row, like `SyncPostContentMedia`. The migration backfills
  from both copies.
- **`GET /media/:id/posts` gains `site_templates`** (`MediaSiteTemplateUse`: id, theme, kind, slug, title,
  `published`, `working`, `usages` as for posts; a captions file through the video blocks showing a video it captions)
  **and `site_logo`** (it is `settings.site_logo_media_id`). Each entry says `theme_active`. Only admins see working
  copies and other themes' designs (the Site editor is theirs); other roles see the active theme's templates whose
  published copy shows the file, which is on the site anyway. A deleted media
  renders nothing in the part: the resolve lists it in the doc's `media_missing`, as for posts. Tests:
  `media_used_in_site_test.go` (mock), `site_template_media_db_test.go` (real DB).

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
  page 404 unless the status is `published`. **Restore (#286) never writes `block_doc`
  from the API:** `POST /posts/:id/versions/:no/restore` (`restorePostVersion`,
  `requireContentEditor` + `authorizeWritePost`, the same callers as before) hands the
  version to the collab server (`restoreCollabVersion`: `POST
  /internal/documents/post-<id>/restore {block_doc, user_id}`, `collabRestoreTimeout` 30s,
  longer than the collab server's own load + store), which puts it into the live doc
  through a direct connection (open or not) and stores it, then answers. Only then are
  the version's settings written (below) and `version_restored` recorded. Collab down,
  unreachable or its store failed → **503 `collab_unavailable`, nothing changed** (no
  settings, no activity); a version it can't store → 422 `version_unrestorable`; a timeout
  → 503 `restore_unconfirmed` (it may still land). Settings failing after the blocks landed
  → 500 `settings_not_restored` with the blocks' result. The only `block_doc` writer for
  an existing post is still the collab server's `PUT /internal/posts/:id/collab`.
  Templates and parts (#492) still restore through the Site editor (rule 9 there).
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
  snapshot** on purpose: it changes at once, with its conflict check. Restoring: `POST
  /posts/:id/versions/:no/restore` (#286, above) restores the blocks through the collab
  server, then writes the version's settings into the working copy only
  (`restoreVersionSettingsTx` → `RestorePostSettingsTx`); `POST .../restore-settings` is
  that second half alone, kept for editor tabs from before #286 (they restore the blocks
  through their editor first). `GET /posts/:id/settings` says whether they differ from the
  published ones.
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

## Nested blocks (#414, `post_blocks_nesting.go`)

- Containers (Group, Details) hold their child blocks **by id** in `children`, each a full block
  in the flat `blocks` map, like a list's items. The table (`blockContainers`, `flowBlockTypes`)
  mirrors the web's `blocks-spec/nesting.ts`; `TestNestingVectors` reads the web's
  `nestingVectors.json`, which the collab store's tests read too, so both refuse the same docs.
- `prepareForStore`: `deduplicateBlocks` (repeats within `blocks_order` and within each
  `children`, first kept: such docs exist and must keep storing), then after the sanitizer
  `checkBlockNesting` (every referenced id exists, each block referenced at most once, no
  cycles, a container's children of the table's types and count, `children` an array of
  strings, no `children` on a core block that isn't a list or a container) → 400.
- The sanitizer still walks the flat map, so a nested block gets its type's rules.
  `sanitizeGroupAttrs` is an allowlist (`style` none/tinted, `align` content/wide/full; anything
  else deleted).
- **Callout, pull quote, to-do list (#419):** flow types (`flowBlockTypes`); `todo_list` is a
  list (`listBlockTypes`) whose items are `todo_item` (`listItemBlockTypes`). Their attrs are
  allowlists like a group's (`keepOnlyAttrs`): callout `pm`/`text`/`tone` (`calloutTones`, an
  unknown tone is dropped), pull quote `pm`/`text`/`cite` (`sanitizeCite`, the quote's rules),
  to-do list none, to-do item `pm`/`text`/`checked` (a boolean, else dropped); the same attr in
  `pm.attrs` is removed (`deletePMAttr`). Tests: `post_blocks_text_blocks_test.go` and the shared
  `nestingVectors.json`. The search text (000024) already reads `text`, `cite` and `children`.
- **Table (#420, `post_blocks_table_test.go`):** a flow type (`flowBlockTypes`), rows in its
  pm, no `children`. `sanitizeTableAttrs` is an allowlist (`pm` that is a `table` node, `text`
  string, `headerRow` only `true`, `caption` reduced like an image's by `sanitizeCaption`), and
  `sanitizeTableGrid` keeps no attrs on `table`/`tableRow` and only `colspan`/`rowspan` on a
  cell, clamped to 1..`tableMaxSpan` (64, the web's `TABLE_MAX_SPAN`) and left out when 1, at
  any depth of a table block's pm (another block's node of the same name is left alone). The
  header row is the block's `headerRow`, never in the pm. The bridge's output passes through
  unchanged (a test pins it).
- **Details (#421, `post_blocks_details_test.go`):** a container (`blockContainers`: flow,
  1+; a group accepts it). Its summary is an attr, not a child: `sanitizeDetailsAttrs` is an
  allowlist (`summary` reduced like a caption by `sanitizeCaptionRuns`, `text` a string, `open`
  only `true`). An image in a details is in `post_media` (`walkBlocks`). Four cases in
  `nestingVectors.json`.
- **Columns, buttons, spacer (#426, `post_blocks_layout.go`, `post_blocks_layout_test.go`):** two
  rows of `blockContainers` (`columns` 2–4 of `column`, in a group or at the top; `column` flow and
  details, `nestedOnly`: never in `blocks_order`) and two flow types. Each an allowlist:
  `sanitizeColumnsAttrs` (`layout`, `align`), `sanitizeSpacerAttrs` (`size`, a theme step, never
  pixels), `sanitizeButtonsAttrs` (`pm` a `buttons` node of `button` nodes only, `text`, `align`). **A
  button's `href` is a node attr, which the link-mark check never saw:** `sanitizeButtonNode` keeps
  only an `isSafeURL(href, safeHrefSchemes)` one and runs from `sanitizePMNode` too, so a `button` in
  any block's pm is covered. `buttonHrefVectors.json` is the web's too.
- **Cover and media & text (#427, `post_blocks_cover.go`, `post_blocks_cover_test.go`):** two rows of
  `blockContainers` (`cover` flow only, `media_text` flow and details; a group holds media & text,
  never a cover). Each an allowlist: `mediaId`, `alt` (plain text, 255 code points), `decorative` (a
  boolean), `focal` (x and y clamped to 0–100, whole; anything else is deleted), and a cover's
  `overlay` (clamped to 0–80, snapped to steps of 5) and `align`, a media & text's `position`.
  `coverMediaVectors.json` is the web's too. Both are in `mediaBlockTypes` (post_media, "Used in", the
  public `media` map), their entries an image's: variants, no file info (`imageBlockTypes`).
- **Gallery (#424, `post_blocks_gallery_test.go`):** a container (`blockContainers`: `image` only,
  0+; a group doesn't accept it). Its caption is an attr, not a child: `sanitizeGalleryAttrs` is an
  allowlist (`columns` a number clamped to 2–4, anything else deleted; `caption` reduced like an
  image's by `sanitizeCaption`). Its images are image blocks, so they get the image rules and are in
  `post_media` through `walkBlocks` ("Used in"). Six cases in `nestingVectors.json`.
- **Footnotes (#422, `post_blocks_footnotes_test.go`):** `footnotes` is a container (`footnote` only, 1+, `onePerDocLast`: one per doc, the last
  of `blocks_order`, in `checkBlockNesting`); `footnote` a core type that only lives in it. A `footnoteRef` is an inline node with an allowlist
  (`footnoteId` only, a block id; `sanitizeInlineNodeAttrs`), dropped when invalid. `sanitizeFootnoteAttrs` keeps `pm` (a footnote node with no
  reference in it) and `text`. A note nothing refers to is kept: the API never deletes one. `regenerateBlockIDs` remaps `footnoteId` with the block
  ids, or a duplicated post's references would all go stale. No migration.
- **Marks are an allowlist (#418, `post_blocks_marks_test.go`):** `sanitizeMarks` keeps only
  `allowedMarkTypes` (bold, code, italic, strike, underline, link, highlight, superscript,
  subscript: exactly the editor schema's marks, checked by the web's
  `blocks-spec/markAllowlist.test.ts`), at any depth of any block's pm (theme blocks too) and in
  captions (`captionMarks` first). Any other mark is dropped, its text kept; a run left with no
  marks loses the key. Only a link keeps attrs (`href` checked, `on*` stripped); every other mark
  keeps none, so a highlight never carries a colour. **Add a new editor mark there**, or every
  store strips it.
- **`contentMediaUses` walks the tree** (`walkBlocks`: blocks_order, then children depth
  first, each once), so an image in a group is in `post_media` and "Used in".
  `blockDocMediaIDs` (the public `media` map) already walks the flat map. `regenerateBlockIDs`
  needed no change (`TestRegenerateBlockIDsNested`).
