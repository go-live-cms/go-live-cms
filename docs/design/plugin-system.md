# Plugin system: manifest, registry, extension points, runtime loading (#432)

Status: **design, proposed**, 2026-11. No code ships with this document. Issue #432 named
the file `docs/design/plugins.md`; it lives here as `plugin-system.md`.

Feeds: #11 (admin Plugins page), #332 (theme upload), #412 (visual theme builder). Read
with: `docs/design/block-library.md` (#352), `docs/design/block-map-yjs-schema.md` (#315),
`web/themes/README.md` ("Custom Blocks"), `web/gl-admin/lib/collaboration/CLAUDE.md` (the hard
rules; "rule N" below means those), `web/collab-server/CLAUDE.md`.

## Summary

The triage on #432 settled three things: for Beta a plugin is trusted server code, it ships in
the image, and the first extension points are content blocks, server hooks on save, publish and
delete, and a settings panel on `extension_settings`. Public page and `<head>` injection come
later. This document works out the rest:

1. **A plugin is a directory, `web/plugins/<slug>/`,** with a `plugin.json`. The API scans it at
   startup into a `plugins` table, like themes. A new plugin starts disabled.
2. **The schema follows what is installed, never what is enabled.** A plugin block's node is
   in the editor and collab schemas whenever the plugin is in the build, as a theme's block is
   whichever theme is active. Enabling or disabling a plugin doesn't change the schema
   fingerprint (#416), so it restarts nothing and does nothing to open editor tabs. Only a
   deploy that adds, removes or upgrades a plugin's blocks changes the fingerprint, and that
   already has a safe path: `schema-mismatch`, then "Reload to keep editing".
3. **A plugin block's headless half is data, not code.** `block.json` replaces the theme
   blocks' `index.ts`, because `defineThemeBlock` only ever builds a node from plain values. The
   collab bundle gains no plugin JavaScript, so rule 13 isn't touched, and the Go API reads the
   same file. This is also what makes a later runtime install possible for the collab server.
4. **A plugin block is never deleted.** Disabled: it still edits and renders; it just isn't
   offered in the menus. Removed: it is hidden and kept, as a removed theme's block is. Section
   4.4 fixes a gap here that themes have today: this only holds on a seed, and a post with stored
   Yjs state goes read-only instead.
5. **Hooks run after the commit, from an outbox, in-process Go for Beta.** The only thing that
   happens inside `PublishPostTx` is one `INSERT` of an event row, by a trigger. A hook can't
   fail, slow or roll back a publish. The one exception is a publish guard, which runs before the transaction,
   must be declared in the manifest, and allows the publish on error unless it declares
   otherwise.
6. **Runtime loading, shared with #332 and #412.** Split by what is being delivered. #412's
   templates and styles are **data** and need no loader. Uploaded **code** (#332, later plugins)
   gets a **site build**: a network-less builder container compiles the installed extension set
   with the unchanged Vite and esbuild pipeline into a versioned volume, then web and collab
   restart onto it. No image rebuild, no CD run. Every existing guard (globs, bundle checks,
   fingerprint equality) keeps working because the code path is the same one CD runs. Loading
   precompiled `.astro` at request time is rejected: section 8.3 says why.

Three existing problems the plugin work has to fix first are in section 1.1.

---

## 1. Where things stand

- **Themes** are the precedent. The API scans `web/themes/*/` at startup (`ScanThemesDirectory`,
  `SyncThemesToDatabase`). Astro resolves `theme.config.ts`, `functions.ts` and layouts through
  `import.meta.glob`, in the middleware, `index.astro`, `[post_type]/index.astro`,
  `term.archive.astro`, `search/index.astro`, `author/[username].astro`, `ThemedErrorPage.astro`,
  `PostPage.astro` and the admin's `ThemeContext.tsx`. All of it is resolved when the image is
  built (#272).
- **Theme blocks (#376)** are three files per block: `index.ts` (headless), `editor.ts`,
  `render.tsx`. Vite globs them for the admin and SSR. The collab bundle globs `index.ts` through
  `collab-server/importMetaGlob.mjs`. The API reads `themes/blocks.manifest.json`, generated from
  `index.ts` and committed. "Installed" means "in this build", whichever theme is active. Only the
  block menus follow the active theme (`menuEntries`, `entry.theme`).
- **The three images must come from one commit**, and CD builds them that way
  (`scripts/deploy/deploy.sh`). The collab image holds one file and no `node_modules` (rule 13).
- **`extension_settings`** (`000006`) has `key` as its whole primary key, plus `extension_type`
  (`plugin` | `theme`) and `extension_id`. Only themes use it.
- **Nothing runs user code on the API today**, and there is no event or job system. The nearest
  patterns are the scheduler (`RunScheduledPublishing`: a loop in every replica, a claim with `FOR
  UPDATE SKIP LOCKED` and a lease) and `runInBackground`.

### 1.1 Problems found while writing this

None of these is a plugin bug yet. Each becomes one the moment a plugin exists.

| # | Problem | Where | Consequence |
|---|---|---|---|
| 1 | A post with **stored Yjs state** containing a block of a removed extension loads that state as is. The editor's gate can't build the node, so the **whole post** opens read-only. | `loadIntoDoc` (`usableState` → `Y.applyUpdate`), `findUnbuildableTypes`, `Editor.tsx` | `themes/README.md` says the block is hidden and the rest stays editable. That is only true on a **seed**, meaning a post with no usable state. Section 4.4. |
| 2 | **`GET /extension-settings` and `/:key` are public** and return every type. `route_auth_test.go` allows it because the public theme reads them. | `settings_routes.go`, `listExtensionSettings` | A plugin's API key stored there would be world-readable. Section 6. |
| 3 | `ThemeSettingsImpl` doesn't round-trip: `set` writes the bare `key`, `get` and `delete` read `<slug>:<key>`, and `getAll` expects an array where the API answers `{extension_settings, count}`. | `web/src/lib/theme-settings.ts` | A theme's stored setting is never read back, and two themes' same key collide on the primary key. Don't copy this code for plugins. Section 6. |

The `theme:` namespace is also hard-coded in six files (section 5.1). An unrecognised `plugin:`
type would fall into the pre-#376 stand-in path and hit problem 1 at once.

---

## 2. Trust and capabilities

**A plugin is trusted code running with the full authority of the process it's in.** The
triage decided this for Beta. Consequences:

- Only site admins enable, disable or configure one (`requireSiteAdmin`; `RequireRole` in the
  router). Enabling shows a clear warning: "This plugin runs on your server with full access to
  your site's data."
- Every lifecycle action is written to the activity log (#324): `plugin_enabled`,
  `plugin_disabled`, `plugin_settings_updated` (names of the fields, never values). The startup
  scan records `plugin_installed`, `plugin_updated` and `plugin_missing` with the system actor.
  `activity.object_id` is a bigint, which is why `plugins` has a numeric `id` as well as a slug.
- Sandboxing, signatures and verification tiers belong to the *Ecosystem (Marketplace &
  Verification)* milestone.

**Capabilities are declared, shown and used for scoping. They are not a security boundary in
Beta.** `plugin.json` lists what the plugin says it uses:

| Capability | Gives a hook (section 7.8) |
|---|---|
| `posts:read` | `host.Posts()`: read a post's working copy or published snapshot by id. |
| `media:read` | `host.Media()`: read media rows. |
| `users:read` | `host.Users()`: id, name, role. Never the email or password fields. |
| `network` | Nothing; declares that the plugin makes outbound calls. |

The Plugins page lists them, and `Host` only hands out the accessors declared, so a plugin that
forgets one fails in development rather than in production. In-process Go can still import
`database/sql`, and the UI must not imply otherwise. There is deliberately **no `posts:write`**:
nothing may write `block_doc` around the collab server (rule 11).

**RBAC.** Plugins add no roles. A hook runs as the system (actor 0 in the activity log), not as
the user who triggered the event; the event only carries that user's id. A plugin block may
declare `roles` for the block menus, which is the catalog's existing UI hint and not enforcement
(`entryRoles`; #428 shows what enforcement costs).

---

## 3. Package and manifest

```
web/plugins/<slug>/
  plugin.json             # Required.
  README.md
  blocks/<Name>/
    block.json            # Headless definition. Data only. Section 5.1.
    editor.ts             # Admin only: node view + menu entry.
    render.tsx            # Public renderer (SSR, the admin's preview, hydrating themes).
  server/*.go             # Go hooks, package server. Section 7.
```

It lives under `web/` because the web and collab images build with `web/` as their context and
can't see the repository root. The API's context is the root, so `.dockerignore` gains
`!web/plugins` next to `!web/themes`.

```jsonc
{
  "manifest_version": 1,
  "id": "reading-time",          // ^[a-z][a-z0-9-]{0,62}$, equals the directory name
  "name": "Reading time",
  "version": "1.2.0",            // semver, compared on upgrade
  "author": "Ana Costa",
  "description": "Adds an estimated reading time block.",
  "plugin_api": 1,               // the extension contract this plugin was written against
  "capabilities": ["posts:read"],
  "blocks": ["Estimate"],        // directories under blocks/
  "settings": {                  // section 6
    "words_per_minute": { "type": "number", "integer": true, "minimum": 50, "maximum": 600,
                          "default": 200, "label": "Words per minute" }
  },
  "server": {
    "hooks": [                   // section 7
      { "event": "post.published", "timeout_ms": 5000 },
      { "event": "post.before_publish", "on_error": "allow" }
    ]
  }
}
```

- **`plugin_api`, not a GoLive version range.** Images are tagged by commit and there are no
  releases, so a semver range would have nothing to compare to. Core has one constant range. A
  plugin outside it is listed as `incompatible` and can't be enabled.
- The manifest is checked by one validator in Go, with cases in a shared vectors file read by
  both test suites, the pattern `themeBlockVectors.json` set. A plugin in the repository that
  fails it fails CI.
- Rejected: declaring blocks in `plugin.json` itself. Each block already needs a directory for its
  editor and renderer halves, and the globs find `block.json` beside them. One central list would
  need a second way to match them up.

---

## 4. Registry and lifecycle

### 4.1 Table

```sql
CREATE TABLE plugins (
  id           bigserial PRIMARY KEY,
  slug         varchar NOT NULL UNIQUE,
  name         varchar NOT NULL,
  version      varchar NOT NULL,
  author       varchar NOT NULL DEFAULT '',
  description  text    NOT NULL DEFAULT '',
  manifest     jsonb   NOT NULL,
  content_hash varchar NOT NULL,                 -- SHA-256 over the plugin's files
  status       varchar NOT NULL DEFAULT 'installed'
               CHECK (status IN ('installed', 'missing', 'incompatible')),
  enabled      boolean NOT NULL DEFAULT false,
  enabled_at   timestamptz,
  enabled_by   bigint REFERENCES users (id) ON DELETE SET NULL,
  installed_at timestamptz NOT NULL DEFAULT now(),
  changed_at   timestamptz NOT NULL DEFAULT now()
);
```

`content_hash` is the foundation the milestone's "signed packages" line asks for: it says exactly
what is installed, and a signature later signs that value.

### 4.2 Discovery

At startup the API scans `web/plugins/*/plugin.json`, next to `ScanThemesDirectory`, and upserts.
One difference from themes matters: **`SyncThemesToDatabase` deletes rows for themes gone from
disk; the plugin scan never deletes.** A plugin that disappears becomes `status = 'missing'`,
keeps `enabled` and its settings, and comes back as it was if a rollback or a later deploy brings
it back. A hook registered in Go that has no manifest entry, or the reverse, makes the plugin
`incompatible` and logs it, so the two can't drift silently.

### 4.3 Enable and disable

`POST /plugins/:slug/enable` and `/disable` (admin) flip the row and record the activity. They
don't touch the schema (section 5.3). Who reads the state:

| Reader | How | Effect |
|---|---|---|
| Hook dispatcher | The `plugins` table, on every claim | Runs enabled plugins only. Runs still pending for a disabled plugin are skipped. |
| Block menus | `GET /plugins/enabled` (content roles: slugs only), through `ThemeProvider`, like `setActiveTheme`; again when the tab becomes visible | `menuEntries` gains `(!entry.plugin \|\| enabled.has(entry.plugin))`. A failed read offers none, and existing blocks still edit. |
| Plugins page (#11) | `GET /plugins`, `/plugins/:slug`, `/plugins/:slug/usage` (admin) | The list, and "used in N posts" in the disable confirmation. |

`usage` counts posts whose working copy or published snapshot holds a block with the prefix
`plugin:<slug>/`, walking `jsonb_each(block_doc->'blocks')`. It's a full scan, admin-only and
rare, so no index.

### 4.4 What happens to content

The rule is that **no state of a plugin ever changes or deletes a stored block.** The one action
that removes data is "Delete plugin data" on the Plugins page, which removes only the plugin's
`extension_settings` rows.

| | Enabled | Disabled | Removed from the build (`missing`) | Back in the build |
|---|---|---|---|---|
| Editor and collab schema | has it | has it | doesn't | has it |
| Existing block in the editor | edits | **edits** | hidden, kept, rest of the post edits | restored in place |
| Offered in the block menus | yes | no | no | if enabled |
| API on store | validated from the spec | validated from the spec | generic sanitizer only, kept | validated |
| Public page | renders | **renders** | renders nothing, logged once per type (`BlockRenderer`) | renders |
| Hooks | run | don't | can't | if enabled |
| Settings | shown | kept | kept | kept |

**Why a disabled plugin's block keeps rendering.** Disable is the action an admin takes to stop
a misbehaving hook. It must not change published pages as a side effect, and it matches the theme
precedent, where every installed block works whichever theme is active. An admin who wants the
block off the site removes it from the posts, using the usage list. What a renderer that throws
should do is an open question (section 11).

**Removal, and problem 1 from section 1.1.** A seed already does the right thing:
`blockDocToPMWithReport` drops an unbuildable namespaced block, `meta.dropped` keeps it byte for
byte, and every store puts it back. But `loadIntoDoc` only seeds when there is no usable state,
and nearly every post that has been opened has one. Such a post loads with the node still in the
fragment, the editor's rule 10 gate refuses to bind, and the post is read-only until someone
intervenes. Its content is safe, but it's not the behaviour the docs describe.

The fix belongs in the only place that seeds (rule 11), in `loadIntoDoc`, and it fixes themes too:

1. Apply the stored state to a **scratch** `Y.Doc`, not the one Hocuspocus handed over.
2. Decide whether to reseed. It's needed in either direction: **(a)** the fragment holds a
   namespaced node (`theme:` or `plugin:`) the schema lacks, at any depth; or **(b)** `meta.dropped`
   holds a namespaced block the schema now knows, and a dry-run seed of the derived doc drops fewer
   blocks than `meta.dropped` has. (b) is what makes a reinstall bring a block back, since a post
   reseeded at removal has usable state again. The dry run stops a block dropped for another reason
   (bad content, a newer version) from reseeding on every load. If neither holds, apply the state
   to the real doc and continue as today.
3. Otherwise derive a block doc from the scratch fragment with `fragmentToBlockDoc` (with
   `meta.dropped`). **From the state, not `block_doc`**: a post whose last store was `kept-invalid`
   has edits `block_doc` doesn't. A node with no real schema goes through a stand-in, which would
   put its declared attrs inside `pm`, the wrong shape for a reinstall, so each such block takes
   its stored version from `block_doc` by id when it has one, and otherwise has its attrs lifted
   out of `pm` onto the block.
4. Seed the real doc from that, under a **new epoch** (rule 12), with outcome `seeded`, reason
   `uninstalled-blocks`. A tab holding the old structs gets `stale-epoch`. The seed is PUT at once
   as usual. **`seedFragment` must stop making stand-ins for namespaced types.** A plugin node can
   sit inside a quote's or list item's `pm`, because it is in the `block` group; a stand-in there
   would leave it in the fragment, the editor still couldn't bind, and step 2 would reseed on every
   load. Without one, that parent fails to build and is hidden and kept whole (#213), which costs
   the quote until a reinstall. `fragmentToBlockDoc` keeps its stand-ins: it needs them to read the
   state.

Tests: a stored state with a removed plugin's block, top-level, inside a Group and inside a quote,
loads with the rest editable and reseeds once; stores keep the block; reinstalling restores it in
place; and a block dropped for another reason doesn't reseed.

### 4.5 Upgrades

A plugin version is a schema contract. Widening is safe (a new attr with a default, a wider
`content`), and it changes the fingerprint, so it is an ordinary deploy. Narrowing `content`, or
removing an attr's values from an `enum`, leaves stored docs that a seed's `check()` hides (#213).
So a breaking change needs a new block type (`plugin:x/note-2`) or a bumped block `version` whose
renderer reads both. The rule that hides a stored version newer than the build reads applies only
at a seed. A post with stored state keeps editing after a rollback, on the older spec, and its next
store writes the older version without the attrs that spec doesn't declare. Treat a rollback across
a block version like a down migration: restore the pre-release backup, or roll forward.

---

## 5. Plugin blocks and the collab constraints

### 5.1 Type and definition

- **Type: `plugin:<slug>/<block>`**, also the ProseMirror node name and Yjs element name. Core
  types never contain `:`, so it can't shadow a core or theme block, and a slug is unique.
- `theme:` is hard-coded in `blocks-spec/themeBlocks.ts` (`THEME_BLOCK_TYPE`, `isThemeBlockType`,
  `themeOfBlockType`), `blockBridge.ts` (`themeBlockToPM` dispatch), `blocks-spec/index.ts`
  (`validateBlockDoc`), `BlockRenderer.tsx`, `lib/theme-blocks/editor.ts` (the entry's `theme`) and
  `api/theme_blocks.go` (`themeBlockPrefix`). `collab-server/build.mjs`'s leak check names the
  `themes/` path the same way. All of them become "a namespaced extension block". **This has to land
  first**: an unrecognised `plugin:` type falls into the pre-#376 stand-in path, seeds with a
  stand-in, and the editor can't build it. Done in #452: each of them asks
  `isExtensionBlockType` (TypeScript and Go), and the leak check names `plugins/` too.
- **`block.json` replaces `index.ts` for plugins:**

  ```json
  { "type": "plugin:reading-time/estimate", "version": 1, "title": "Reading time",
    "content": "", "attrs": { "label": { "type": "string", "default": "min read", "maxLength": 40 } } }
  ```

  It holds exactly the inputs of `defineThemeBlock`, which turns plain values into a node and
  nothing else. Same attr vocabulary, same reserved names, same text-only `content` limit
  (`THEME_BLOCK_CONTENT_NAMES`). A new `defineExtensionBlock(json)` is `defineThemeBlock` minus the
  TypeScript import. What this buys: **no plugin JavaScript in the collab bundle**, no stale
  generated manifest (Go reads the same file), and a package the API can validate without running
  it. Theme blocks keep `index.ts` until #332, which needs the same property (section 8.9).

### 5.2 How a plugin block reaches each process

Build time, one commit, as for theme blocks.

| Consumer | Reads | How |
|---|---|---|
| Admin editor | `block.json`, `editor.ts` | New glob beside `installed.ts` / `editorBlocks.ts`. `pluginBlockEditor` takes a node view and a menu entry only, as `themeBlockEditor` does, so a plugin can't add schema or a ProseMirror plugin through it (rule 7). |
| Public SSR and the admin's preview | `block.json`, `render.tsx` | New glob in `src/components/blocks/registry.ts`. |
| Collab server | `block.json` only | Same glob, through `importMetaGlob` in `build.mjs`. `collab-server/Dockerfile` adds `COPY plugins ./plugins`. The `editor`/`render` leak check extends to `plugins/`. |
| Go API | `plugin.json`, `block.json` | Read at startup. `web/plugins` is copied into the image as `web/themes` is. The specs merge into `server.themeBlocks`, so `applyThemeBlocks` validates them unchanged. |

One list drives the schema everywhere: `getInstalledCollabSchema` and the editor's
`getExtensions` both take **theme blocks then plugin blocks, sorted by type**. Node order is part
of the fingerprint, so this can't be left to each caller. `schema.test.ts` and `process.test.ts`
already prove the editor, bundle and server agree, and `themeBlocks.loadable.test.ts` extends to
plugins.

### 5.3 The fingerprint, and why the schema is the installed set

`schemaFingerprint` hashes every node's name, content, groups, marks and attrs with defaults, in
schema order. A plugin that adds a node changes it, so the question is *which event* may change
it.

| | Schema = **installed** set (chosen) | Schema = enabled set (rejected) |
|---|---|---|
| Enable or disable | No fingerprint change, nothing restarts, tabs unaffected | Fingerprint changes, the collab process must restart, every open tab is refused and has to reload, for a settings-page click |
| Disabling with blocks in posts | Blocks stay buildable | Every post using one trips rule 10 (section 4.4) |
| Precedent | Theme blocks (#376) | None |
| Cost | A disabled plugin's node stays in the schema | |

### 5.4 What enabling does to open editor tabs

**Nothing to the document or the connection.** No fingerprint change, no reconnect, no reseed, no
collab restart. The insert menus pick up the change when the tab next reads the enabled list, on
load and when it becomes visible again. A tab that hasn't noticed yet can still edit an existing
block of the plugin and can't yet insert a new one, and nothing is wrong either way, because the
schema is the same on both sides. Disabling is the same in reverse.

### 5.5 What installing, upgrading or removing does

These change the image, so they are a deploy and go through the path every new core block has
used since #416:

1. CD builds api, web and collab from one commit, so all three agree.
2. `deploy.sh` recreates the services. The collab process stores every document on SIGTERM.
3. Open tabs reconnect with the old fingerprint and are refused with `schema-mismatch`, before the
   access lookup and before the doc loads, so a refused tab causes no write. The tab keeps the
   bound doc read-only and shows "The editor was updated. Reload to keep editing."
4. A deploy that doesn't change the schema (a hook-only plugin, a renderer change) has the same
   fingerprint, and tabs reconnect without noticing.

The only exposure is what every deploy has today: keystrokes the server hadn't received when it
restarted can't sync into a refused tab. The tab's unload warning covers that.

### 5.6 Rule by rule

| Rule | Status |
|---|---|
| 0 (no client cache) | Plugins get no Yjs access; `editor.ts` is a node view. |
| 7 (`appendTransaction` ignores sync) | The editor contract gives no way to add a ProseMirror plugin. A plugin that bypasses it is a review failure, since the code ships in the repository. |
| 8, 13 (one yjs) | `block.json` has no imports, so the bundle's module graph doesn't change. `web/` stays the only package, and a plugin has no `package.json` of its own. |
| 10 (never bind what can't be built) | Fingerprint covers tabs on an old bundle; section 4.4 covers docs holding an uninstalled type. |
| 11 (only the server seeds, nothing writes `block_doc` around it) | Hooks can't write content (section 7.2). Section 4.4's reseed is in `loadIntoDoc`. |
| 12 (revision, epoch) | Section 4.4's reseed takes a new epoch. |

Blocks hold text only, as theme blocks do, so no block or media hides in a plugin block's `pm`.
Plugin *containers* wait for the same later design as theme containers (block-library 2.11).

---

## 6. Settings panel

Keep `extension_settings`, as the triage decided, with these changes:

- **Key:** `plugin:<slug>:<name>`, because `key` alone is the primary key. `setting_key` already
  allows `:`. `extension_type = 'plugin'`, `extension_id = <slug>`.
- **Separate, admin-only routes:** `GET` and `PUT /plugins/:slug/settings`. `PUT` validates each
  value against the manifest with the attr rules that already exist on both sides
  (`attrProblem`, `themeAttrProblem`) and records `plugin_settings_updated`.
- **Close the public read (problem 2).** The public `GET /extension-settings` and `/:key` answer
  only `extension_type = 'theme'`, and `PUT` and `DELETE` there refuse `plugin`. Tests:
  `route_auth_test.go` keeps its reason, and a new case proves a plugin row is never served.
- **`"secret": true` fields** are write-only. `GET` answers `{"set": true}`, never the value, and
  only `host.Settings()` reads it. They are stored in the database in the clear for Beta, which
  means database backups contain them. Encrypting at rest needs a key and a rotation story, so it
  isn't worth starting before a plugin needs it.
- **The form** is built from the manifest's `settings`: `string` is a text field (`enum` a select),
  `number` a number field, `boolean` a switch, using the #338 components on #11's page.
- **Fix `ThemeSettingsImpl` (problem 3)** while here: one key format, and read the real response
  shape. Plugins get their own thin client and don't share it.

---

## 7. Server hooks

### 7.1 Where hooks run

| | In-process Go, compiled in (chosen for Beta) | Go `plugin` package | go-plugin or WASM sidecar | Webhook |
|---|---|---|---|---|
| Fits "ships in the image" | Yes | Yes, in principle | Overkill | Works without the image |
| Failure isolation | Panic recovered; a stuck goroutine costs its slots (7.6) | As in-process | Process boundary | Network boundary |
| Installable without a rebuild | **No** | Exact-toolchain match, Linux only, never unloads | Yes | **Yes** |
| Cost | Small | Fragile | Large | Signing, SSRF policy, retries |

Plugins registered in Go are linked by a generated `api/plugins_gen.go` (blank imports of each
`web/plugins/*/server`), produced by `cmd/gen-plugins` and committed, with a `--check` in CI like
`themes:manifest`.

**Go has no runtime loading story.** A plugin installed later without a rebuild can only have
hooks **out of process**, which means webhooks on the same outbox (Phase 5). That is why delivery
is separated from the event below.

### 7.2 Events, and where they come from

Events are written by **one trigger on `posts`**, not by Go. Publishing has more paths than it
looks: the Publish button and bulk (`publishPostByID`), the scheduler, scheduled updates, and a
`post_status` set through `PUT /posts/:id` or `POST /posts`, which moves no version at all.
`000044`'s `posts_resolve_review_on_publish` already solved this for updates, and writes its
activity row inside the publish's transaction, so a new path needs nothing.

| Event | Trigger condition | Notes |
|---|---|---|
| `post.saved` | `INSERT`, or `changed_at` moved | Covers a collab store that wrote `block_doc` (`StorePostCollabTx` bumps it; a state-only store doesn't), `POST /posts`, duplicate, from template, and REST settings saves. **Observe only.** The collab store may be holding the only copy of an edit and it never throws, so a save can never be blocked or changed. Coalesced below, since the store's debounce allows one every 2 to 10 seconds per open document. |
| `post.published` | `post_status` becomes `published` (not from `trash`), a new `published_version_id`, or an `INSERT` with status `published` | `000044`'s condition, plus the insert it doesn't need. The actor is the new version's `created_by`; NULL for a status set through PUT or POST. |
| `post.unpublished` | `post_status` leaves `published`, other than to `trash` | So anything that mirrors the site can follow it. |
| `post.before_publish` | Not an event: a guard (7.7) | |
| `post.trashed` | `post_status` becomes `trash` | `DELETE /posts/:id` is a move to the trash (#327). |
| `post.restored` | `post_status` leaves `trash` | The inverse of `post.trashed`. `post.published` excludes it, since a restore puts the old live version back. |
| `post.deleted` | `DELETE` of the row | Permanent. The row is gone when the hook runs, so the event carries `post_type`, as the activity entry does. |

The issue's "delete" is trashing and deleting both: a plugin that mirrors content to a search index
wants `post.trashed` and `post.restored`, and one that cleans up wants `post.deleted`.

**No mutating filters.** A hook can't change the content on the way through a save or publish.
Rule 11 forbids the save half, and on publish the version snapshot would stop matching what
editors saw. A plugin that needs a derived value stores it elsewhere.

### 7.3 What may run inside `PublishPostTx`

`PublishPostTx` locks the post row (`LockPostForPublish`), writes the version and the published
snapshot, and syncs media links, in one transaction. The rule:

**May run inside:** short, deterministic statements on the same transaction. For plugins that is
exactly one statement, the trigger's event insert.

**May not run inside**, and the reason each is dangerous here:

| Not inside the transaction | Why |
|---|---|
| Any plugin code | It could fail, panic or hang inside the lock, and an error would roll back the publish. |
| Network calls, including the collab flush | The collab store takes this row's lock (`StorePostCollabTx`), so a flush from inside would wait on itself until it timed out. That is why the flush is already outside. |
| Anything else that waits on the post's row | Same deadlock, and every collab store of that post queues behind it. |
| Mail, files, long reads | They hold a pooled connection and the row lock for their whole duration. |

The event is the point of the design: it commits **with** the publish, so there is no window where
a publish happened and a crash lost its event, or an event describes a publish that rolled back.

### 7.4 The outbox

```sql
CREATE TABLE plugin_events (
  id         bigserial PRIMARY KEY,
  event      varchar NOT NULL,
  post_id    bigint  NOT NULL,        -- no FK: post.deleted must outlive the post
  actor_id   bigint,
  data       jsonb   NOT NULL DEFAULT '{}'::jsonb,  -- ids and small facts only, as activity
  fanned_out boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- At most one post.saved per post waiting for fan-out (7.4 covers the wait after it).
CREATE UNIQUE INDEX plugin_events_one_pending_save ON plugin_events (post_id)
  WHERE event = 'post.saved' AND NOT fanned_out;

CREATE TABLE plugin_hook_runs (
  event_id        bigint NOT NULL REFERENCES plugin_events (id) ON DELETE CASCADE,
  plugin_id       bigint NOT NULL REFERENCES plugins (id) ON DELETE CASCADE,
  status          varchar NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped')),
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),  -- also the lease while running
  last_error      text,                -- capped, no payloads
  PRIMARY KEY (event_id, plugin_id)
);
```

The trigger's insert is `INSERT ... SELECT ... WHERE EXISTS (an enabled plugin subscribes) ON
CONFLICT DO NOTHING`, so a site with no subscriber writes no row at all, and no Go call site changes.

`RunPluginHooks` is a loop from `main.go` in every replica, shaped like `RunScheduledPublishing`
(`PLUGIN_HOOKS_INTERVAL`, default 1s, 0 = off, SIGTERM stops it after the runs in flight):

1. Fan out: for new events, one `plugin_hook_runs` row per plugin enabled and subscribed **now**.
   A `post.saved` is skipped for a plugin that already has a pending `post.saved` run for that post:
   the hook reads the current post when it runs, so one is enough, and a slow plugin can't build a
   backlog of saves.
2. Claim due runs with `FOR UPDATE SKIP LOCKED` and a lease: the claim sets `running` and moves
   `next_attempt_at` two minutes ahead, as `ClaimDueScheduledPosts` does. A `running` row whose
   `next_attempt_at` has passed (the process died) can be claimed again. The longest timeout is 30s,
   so a live run never loses its lease. The row lock is not held across the hook.
3. Run each outside any transaction, under `runDetached`-style recovery.
4. Record the result.

While no enabled plugin has a hook, the loop only re-reads `plugins` every 30 seconds. `done` runs
are pruned after 7 days and `failed` after 30, like `ACTIVITY_RETENTION`, and an event goes once it
has no runs left.

### 7.5 Ordering

- **Within one plugin and one post:** in event order. A run isn't claimed while an earlier run for
  the same (plugin, post) is unfinished. The trigger runs under the row's lock, so a post's event
  ids follow its commit order. A failing run holds later ones for that pair until it succeeds or
  exhausts its attempts.
- **Across plugins:** no order, and plugins can't depend on each other. They run concurrently.
- **Guards:** deterministic, sorted by `(priority, slug)`.
- **Delivery is at least once.** A crash after the hook but before recording repeats it, so
  `Event.ID` is the idempotency key.

### 7.6 Failure and timeouts

| Situation | Behaviour |
|---|---|
| Hook returns an error, panics or times out | The run is retried with the scheduler's backoff (30s to 10 min), at most 8 attempts, then `failed`. **The publish is long since committed and is unaffected.** |
| Timeout | `timeout_ms` from the manifest, default 10s, maximum 30s, enforced through the context. |
| A hook that ignores its context | A goroutine can't be killed, so concurrency is capped: 2 per plugin, 8 overall. A stuck plugin exhausts only its own slots. |
| Repeated failure | Shown on the Plugins page with the last error; `plugin_hook_failed` in the activity log, throttled. |
| Plugin disabled with runs pending | Skipped at claim. |

### 7.7 Publish guards

A guard is how a hook is *designed* to stop a publish. It's separate from observers, so that the
default can't break a publish:

- It must be declared: `{ "event": "post.before_publish", "on_error": "allow" | "deny" }`. The
  enable dialog lists it: "Can block publishing."
- It runs **before the transaction, on every path that publishes**: `publishPostByID` and
  `publishScheduledPost` after their collab flush, `applyScheduledUpdate` on the frozen snapshot,
  and `POST /posts` and `PUT /posts/:id` when the request sets `post_status` to `published`. A guard
  that only covered the Publish button could be bypassed by that last pair. It gets the block doc
  and post id read-only and returns allow, or deny with a short plain-text reason.
- Budget 3s each and 5s in total, sequentially, first deny wins.
- **A denial** answers 409 `plugin_refused` with the reason. In bulk it's a per-post failure in
  the existing report, and in the scheduler it goes through `recordScheduledPublishFailure` and
  shows as the post's `schedule_failure`.
- **An error or timeout is an allow**, logged, unless the plugin declared `on_error: "deny"`.
- It's a policy check, not a lock: an edit stored between the guard and the transaction is
  published unchecked, the same window the flush has today.

Saves and deletes have no guards: a save can't be refused (7.2), and a delete has no use case
that justifies one.

### 7.8 The Go contract

```go
package pluginsdk // imports nothing from api/ or db/

type Event struct {
    ID, PostID, ActorID int64
    Name                string
    Data                map[string]any
    OccurredAt          time.Time
}

type Host interface {
    Settings(ctx context.Context) (map[string]any, error)
    Posts() PostReader // nil unless posts:read is declared; likewise Media, Users
    Log() *slog.Logger // the API's rules: no secrets, ids not names
}

type Plugin struct {
    Observers     map[string]func(context.Context, Host, Event) error
    BeforePublish func(context.Context, Host, PublishCandidate) (Decision, error)
}

func Register(slug string, p Plugin) // called from init()
```

---

## 8. Runtime loading (shared with #332 and #412)

This is the question the three issues have in common: how new code or templates reach running
processes without building a new image.

### 8.1 What each process has today

| Process | How extension code gets in | Why it can't take more at runtime |
|---|---|---|
| API (Go) | Reads `web/themes` and the manifest at startup. Hooks would be linked in. | The file reads are fine, but only at startup. Go can't load code. |
| Astro SSR | `import.meta.glob`, resolved by Vite at build. | The glob is replaced by a static map of hashed chunks. `web/Dockerfile`'s runtime stage has `dist` and production `node_modules`: no Vite, no sources. A new theme is "not in this build". |
| Admin SPA | Same globs, in the browser bundle. | Hashed chunks, one React and TipTap instance, schema needed before binding. |
| Collab | One esbuild file, no `node_modules`. | Nothing to resolve an import against, by design (rule 13). |

### 8.2 Split by what is delivered

Most of the difficulty belongs to only one of three kinds:

1. **Data.** Stored templates, global styles, tokens, block specs, settings. Reaches every process
   through Postgres and the API. Needs no loader.
2. **Static files.** Compiled CSS, images, fonts. A shared volume and a file server.
3. **Code.** `.astro` layouts, `functions.ts`, `render.tsx`, `editor.ts`, Go.

### 8.3 Options for code

| | A. **Site build** (recommended) | B. Precompile, `import()` at runtime | C. Vite in production | D. Rebuild the images (CD) |
|---|---|---|---|---|
| How | A builder runs the normal `astro build` and collab bundle over core + installed extensions, writes to a volume, web and collab restart onto it | Compile each package separately, load with dynamic `import()` | Run `astro dev` or `ssrLoadModule` | Add to the repo or a derived image, redeploy |
| Globs | Unchanged | Replaced at 13 call sites | Unchanged | Unchanged |
| Full theme features (`<style>`, `client:*`, `@/` imports) | Yes | No | Yes | Yes |
| Existing guards (bundle checks, fingerprint equality, loadable test) | Reused as is | Rebuilt | Partly | Reused |
| Time to activate | A build, to be measured (8.8) | Seconds | Seconds | A CD run |
| Runtime image | Unchanged; builder is separate | Unchanged | Needs dev deps and sources | Unchanged |
| Works without CI or a registry | Yes | Yes | Yes | No |
| Verdict | **Use for #332 and later plugins** | Rejected for now | Rejected | **Beta plugins** |

**Why not B.** It looks like the direct answer, and it fails on specifics of this codebase:

- **Themes depend on core by alias.** The default theme's `.astro` files alone import 15 distinct
  modules through `@/lib/*` and `@/components/*` (`BlockRenderer`, `SeoHead.astro`,
  `Pagination.astro`, `lib/seo`, `lib/postList`, ...). In `dist` those are hashed chunks with no
  stable names. B would need a frozen host ABI of every helper a theme may touch, and that ABI
  would be the real product.
- **`.astro` is more than its compiled function.** Scoped `<style>` extraction, hoisted scripts
  and `client:*` directives are done by Astro's Vite plugins, and an island's hydration URL comes
  from the build's manifest. A separately compiled layout using `<BlockRenderer client:load />`,
  which `themes/README.md` tells authors to write, has no entry there. (This comes from Astro's
  documented build model and wasn't tested against the pinned version.)
- **`render.tsx` reaches three bundles:** SSR, the admin's preview (`registry.ts` is loaded there
  for History), and the public client bundle of any theme that hydrates `BlockRenderer`. All three
  would need the same runtime-loaded module and one React instance.
- **The admin** would need shared module instances for React and TipTap (an import map, under a
  nonce-based CSP) and async plugin loading before the schema-dependent bind.
- **The collab bundle** can't resolve `@tiptap/core`, so a plugin module would carry its own copy.
  Section 5.1's `block.json` removes this one problem, but only this one.

B could return for a narrow case, a sandboxed block renderer under the Ecosystem milestone, where
a small frozen ABI is what's wanted anyway.

**C** runs a compiler per request path in production, needs dev dependencies and sources in the
runtime image, and Astro doesn't support it. **Astro's Container API** renders already-compiled
components, so it doesn't solve compilation.

### 8.4 Recommendation

- **Beta plugins:** Option D. Plugins ship in the image, as the triage decided. Nothing in sections
  3 to 7 needs a loader.
- **#412:** data. No loader, no dependency on this work (8.7).
- **#332, and plugins installed later:** Option A, the site build.

A note for the owner of #332: its acceptance says "without redeploying", which A meets. Its scope
also says "without a rebuild", and A does compile on the server, so read literally it doesn't. The
recommendation is that the compile is the right cost for keeping one code path. If activation in
seconds turns out to be required, the alternative is B's host ABI and restricted theme dialect.

### 8.5 How a site build works

```
Admin uploads a package (#332) or enables a package-installed plugin
  │
  ▼ API: validate, unpack to extensions:/packages/<kind>/<slug>/<version>/ (immutable)
  ▼ API: write extensions:/requests/<set-id>.json     set-id = hash(core commit, package hashes)
  ▼ builder: overlay packages onto its source tree, run the normal pipeline
      themes:manifest → astro build → collab-server/build.mjs → loadable checks
  ▼ builder: write builds:/<set-id>/{web/,collab/server.mjs,manifest.json,fingerprint}, then result.json
  ▼ API: reloads itself, then moves the web pointer, waits for web, then moves the collab pointer
  ▼ web restarts, then collab restarts (last, and only if needed)
```

- **Builder service.** A new image: `web/Dockerfile`'s build stage (sources plus dev dependencies),
  so the runtime images don't grow. **No network** (`network_mode: none`), no secrets, no database,
  non-root. It only sees the `extensions` volume and `builds`. Requests and results travel as files
  on the shared volume because it has no network. Uploads with install scripts or `package.json`
  dependencies are refused. Package code does execute in one place: the loadable checks import each
  block's modules (and the manifest generator evaluates an `index.ts`, one reason a package must use
  `block.json`). That is within the trusted-code model, and it's why the builder has no network or
  secrets.
- **Pointers, one per process and per core commit:** `builds:/pointers/<commit>/{web,collab}`, each
  an atomic rename to a set id. The API is the only writer. A process reads only its own commit's
  pointer (`GOLIVE_IMAGE_TAG`, passed by compose), so a deploy can prepare the new commit's pointers
  while the old containers keep serving.
- **Web** starts from `server/start.mjs`, which follows its pointer to `builds:/<set-id>/web`, or
  the baked-in `dist` when there is none. The output sits under `/app/builds`, so bare imports still
  resolve to `/app/node_modules`. Theme assets are served from the build's copy of `themes/`.
- **Collab** gets a read-only `builds` mount and runs that build's `server.mjs` by the same rule.
  It is still exactly one file with no `node_modules`, and `build.mjs`'s single-yjs and leak checks
  ran on it.
- **API** gets the `extensions` volume and read-write `builds`. On activation it re-runs the theme
  and plugin scans and swaps the block manifest behind an `atomic.Pointer`. It doesn't restart. Web
  and collab poll their own pointer and exit cleanly on a change, and `restart: unless-stopped`
  brings them back; the collab server's SIGTERM path stores every document first.
- **Activation order: API, web, then collab.** The API must know a new block's spec before anything
  can store it. Web must serve the new admin before tabs are told to reload, so the API moves the
  collab pointer only once web answers with the new set id (an `X-GoLive-Build` header). The collab
  restart is what causes the reload, so it goes last. A tab opened in the gap has the new schema and
  is refused by the old collab with the reload prompt, which works once collab is back. **If the
  build's fingerprint equals the running one** (a theme with no blocks, a renderer change), the
  collab pointer doesn't move, and open tabs never notice.
- **Failure.** A failed build changes nothing: the pointers stay on the old build, the admin sees
  the error and the package stays inactive. The last three builds are kept for rollback.
- **Core upgrades.** A build is only valid for its core commit, which is the existing rule that all
  bundles come from one commit. `deploy.sh` gains a step before `up`: run the builder for the new
  tag and the installed set and write that commit's pointers, with the old containers still serving.
  A deployment with no uploaded packages skips it.
- **Backups.** The `extensions` volume joins `backups.md` next to `uploads`. `builds` doesn't: it
  can be regenerated.
- **Limits worth stating.** Packages can't add npm dependencies, so a library must be vendored. One
  build runs at a time. Blue-green (a second web on another port, health-checked, then Caddy swaps)
  can later remove the few seconds of web restart.

### 8.6 What each consumer needs

| | API (Go) | Astro SSR | Admin SPA | Collab |
|---|---|---|---|---|
| **Beta plugins** (in image) | Read `web/plugins`; link hooks | Glob `render.tsx` | Glob `editor.ts` | Glob `block.json` |
| **#332** theme, no blocks | Validate zip, `extensions` volume, rescan, gate Activate on a finished build | **Site build**: layouts, `functions.ts`, assets | **Site build**: `ThemeContext`'s config glob | Nothing, fingerprint unchanged |
| **#332** theme with blocks | Same, plus reload the block specs | Same | Same, plus `editor.ts` | **Restart** on the new bundle; tabs get `schema-mismatch` |
| **#412** builder | New tables, publish flow, `/public` reads | One new generic renderer, shipped in the image once | New editing surface in the image | Nothing, unless templates become collaborative (8.7) |
| **Later: plugin installed at runtime** | Scan; **webhooks only**, no Go | Site build | Site build | Restart if its blocks changed |

### 8.7 What #412 builds on

The builder's output is data, so it doesn't wait for any of this:

- Global styles and template docs live in tables and reach SSR through `/public`, read per request
  and cached (#185).
- `lib/themeLayout.ts` gets one branch: if a published builder template matches, render it with a
  generic layout over `BlockRenderer`; otherwise the theme's layout from the glob, as today. "Reset
  to theme default" deletes the override.
- **Site blocks** (query loop, navigation, post title, and so on) are ordinary **core** blocks,
  in the image, so they change the fingerprint once, in their own deploy.
- `BlockRenderer` is synchronous. A query loop's data must be attached before the render, the way
  the API attaches `doc.media` today. A block can't fetch.
- If template editing is collaborative, a template is a new document kind for the collab server
  (`isCollabDocName`, load, store, access lookup), and the same rules apply. That's a #412 decision
  and is independent of loading.
- "Export as a theme package" produces a #332 package.

### 8.8 What has to be proven first

A spike (S11) before #332 commits to A. It has no production code:

1. Build time and peak memory of `astro build` on the deployment's VM size. A small VM may need a
   memory limit, swap or a remote builder, and this is the biggest unknown in the design.
2. An overlaid theme with `client:load` and scoped styles built and served from `/app/builds`.
3. The collab bundle picked by `start` logic, with `process.test.ts`'s checks against it.

### 8.9 What #332 builds on

Its validation as scoped (no traversal, no symlinks, size limits), plus: no `package.json`
dependencies or `node_modules`, no install scripts, `block.json` required for any block. Then the
flow of 8.5, with "Activate" enabled once the build has finished. Deleting an inactive uploaded
theme removes its package and triggers a build. Its blocks then follow section 4.4.

---

## 9. Phased plan

Each phase is shippable alone. Phases 0 to 4 are Beta.

| Phase | Ships | Depends on |
|---|---|---|
| **0. Prep** | S1 settings exposure and bugs; S2 namespaced blocks; S3 uninstalled blocks in stored state; S4 Plugins artboard on the canvas (the triage's design step) | |
| **1. Registry** (Beta) | S5: `web/plugins`, manifest and validator, `plugins` table, scan, enable and disable, routes, activity | S1 |
| **2. Blocks** (Beta) | S6: `block.json`, the globs, the bundle and API wiring, menu filter, usage count, an example plugin in the repository | S2, S3, S5 |
| **3. Settings and page** (Beta) | S7: settings routes and form; #11 the Plugins page | S1, S4, S5 |
| **4. Hooks** (Beta) | S8: outbox, dispatcher, Go contract; S9: publish guards | S5 |
| **5. Runtime loading** (after Beta) | S10 webhooks on the outbox (the only hooks a runtime-installed plugin can have); S11 spike; S12 builder, volumes, activation; then #332 | S8; S11 before S12 |
| **6. Later** | S13 public page and `<head>` injection; #412 (independent of 5); Ecosystem: signing, sandbox, marketplace | |

Not in Beta, on purpose: installing without a redeploy, plugin-owned database tables, plugin REST
routes, admin pages beyond the settings form, plugin containers, mutating filters, and enforcing
capabilities.

## 10. Proposed sub-issues

Not filed yet. Priorities are suggestions.

| # | Title | Size | Priority |
|---|---|---|---|
| S1 | settings: stop serving plugin rows publicly; fix `ThemeSettingsImpl`'s keys and `getAll` | S | P1 |
| S2 | blocks: generalize namespaced block types beyond `theme:` | S | P1 |
| S3 | collab: reseed a stored doc that holds an uninstalled extension's block (section 4.4) | M | P1 |
| S4 | design: Plugins artboard on the canvas (states per #11) | S | P1 |
| S5 | plugins: package layout, manifest validator, `plugins` table, scan, enable/disable, activity | M | P1 |
| S6 | plugins: content blocks (`block.json`, editor, collab, API, renderer, example plugin) | M | P1 |
| S7 | plugins: settings routes and manifest-driven form | S | P1 |
| #11 | admin Plugins page (exists) | M | P1 |
| S8 | plugins: event trigger and outbox, hook dispatcher, Go contract, `gen-plugins` | L | P1 |
| S9 | plugins: publish guards | S | P2 |
| S10 | plugins: webhook delivery on the outbox (signing, SSRF policy) | M | P2 |
| S11 | spike: site build, time and memory on the deployment VM (section 8.8) | S | P2 |
| S12 | extensions: builder service, volumes, activation, deploy integration | L | P2 |
| #332 | upload a theme package (exists; on S12) | M | P2 |
| S13 | plugins: public page and `<head>` injection | M | P2 |

### Beta milestone checklist

| Milestone item | Covered by |
|---|---|
| Plugin registry (DB + `plugin.json`) | S5 |
| Install/enable/disable (Local/Dev channel) | S5; installing means shipping in the image |
| Capability model | S5 for declaring and showing, S8 for `Host` scoping |
| Signed packages (foundation) | `content_hash` in S5. Signing itself moves to *Ecosystem*, per the triage; the milestone line should be edited to match. |

## 11. Open questions

- **A throwing renderer.** `BlockRenderer` has no error boundary, so one bad plugin renderer fails
  the page. Worth a per-block boundary in S6, or left to review since the code ships in the
  repository?
- **`post.saved` scope.** It covers settings saves as well as body stores. Should those be a
  separate `post.settings_saved`, so a search-index plugin can ignore one or the other?
- **Disabled and public rendering.** Section 4.4 keeps rendering. If a real plugin needs "off means
  off" on the public site, it can be one manifest flag.
- **Where the settings form lives** (#11's question). The design assumes the Plugins page.
