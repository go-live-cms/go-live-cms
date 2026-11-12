# Plugins

Each directory here is one plugin: `web/plugins/<slug>/`, with a `plugin.json`. The design is
`docs/design/plugin-system.md`; this phase (#455) is the registry: the manifest, the scan, and
enable/disable. Content blocks (`blocks/<Name>/block.json`, #456), settings (#457) and server
hooks (#458) build on it.

```
web/plugins/<slug>/
  plugin.json             # Required.
  README.md
  blocks/<Name>/          # One directory per name in "blocks".
  server/*.go             # Go hooks, package server (#458). Linked by api/plugins_gen.go.
```

## plugin.json

```json
{
  "manifest_version": 1,
  "id": "reading-time",
  "name": "Reading time",
  "version": "1.2.0",
  "author": "Ana Costa",
  "description": "Adds an estimated reading time block.",
  "plugin_api": 1,
  "capabilities": ["posts:read"],
  "blocks": ["Estimate"],
  "settings": {
    "words_per_minute": { "type": "number", "integer": true, "minimum": 50, "maximum": 600,
                          "default": 200, "label": "Words per minute" }
  },
  "server": {
    "hooks": [
      { "event": "post.published", "timeout_ms": 5000 },
      { "event": "post.before_publish", "on_error": "allow" }
    ]
  }
}
```

| Field | Rule |
|---|---|
| `manifest_version` | Required, `1`. |
| `id` | Required. `^[a-z][a-z0-9-]{0,62}$`, equal to the directory name. `enabled` is reserved. |
| `name` | Required, not blank, at most 100 characters. |
| `version` | Required, a semantic version (`1.2.0`, `2.0.0-beta.1`). |
| `author`, `description` | Optional strings, at most 100 and 1000 characters. |
| `plugin_api` | Required integer (1 to 1000000): the extension contract the plugin was written against. Outside core's range (today `1` to `1`) the plugin is listed as `incompatible` and can't be enabled. |
| `capabilities` | Optional, distinct values of `posts:read`, `media:read`, `users:read`, `network`. Declared and shown, not enforced in Beta. |
| `blocks` | Optional, up to 50 distinct directory names under `blocks/` (`^[A-Z][A-Za-z0-9]{0,63}$`). |
| `settings` | Optional, up to 50 fields keyed `^[a-z][a-z0-9_]{0,63}$`. Each has `type` (`string`, `number`, `boolean`) and may have `default`, `label`, `description`; strings `enum`, `maxLength`, `secret`; numbers `enum`, `integer`, `minimum`, `maximum`. A `default` must satisfy the field's own rules. |
| `server.hooks` | Optional, one entry per event: `post.saved`, `post.published`, `post.unpublished`, `post.trashed`, `post.restored`, `post.deleted` (may have `timeout_ms`, 1 to 30000), or the guard `post.before_publish` (may have `on_error`: `allow` or `deny`, and `priority`, -1000 to 1000). |

The publish guard `post.before_publish` validates, but the Go contract has no guards until #459:
until then a plugin that declares one is listed as `incompatible` (see "Server hooks" below), so
leave it out of the example above for now.

Unknown fields are refused, at every level. One validator in Go (`api/plugins_manifest.go`) and its
TypeScript twin (`web/gl-admin/lib/plugins/manifest.ts`) share their cases
(`web/gl-admin/lib/plugins/pluginManifestVectors.json`), and both test suites validate every
plugin in this directory, so a plugin that fails fails CI.

## Lifecycle

- **Installing is shipping it in the image.** At startup the API scans this directory into the
  `plugins` table. A new plugin starts **disabled**; an admin enables it (`POST
  /api/v1/plugins/<slug>/enable`).
- **The scan never deletes.** A plugin gone from the build becomes `missing` and keeps its row,
  `enabled` and its settings; putting it back restores it as it was.
- Every change is in the activity log: `plugin_enabled`, `plugin_disabled` by the admin, and
  `plugin_installed`, `plugin_updated`, `plugin_missing` by the scan (the system).
- A plugin is trusted code with the full authority of the process it runs in. Review it as you
  would core code.
- Admins manage plugins on **Workspace › Plugins** (`/gl-admin/plugins`, #11): enable and
  disable behind a confirmation, and a settings form built from `settings` (#457). Values are
  stored as `plugin:<slug>:<name>` in `extension_settings`, admin-only; a `"secret": true` field
  is write-only (the page shows "Saved" and Replace, never the value). **Delete plugin data**
  removes the plugin's saved settings and nothing else; its blocks in posts are never touched.
  Saving records `plugin_settings_updated` with the field names, never the values.


## Server hooks (#458)

A plugin observes posts with Go code in `server/` (package `server`) that registers its hooks with
`pluginsdk` (`pluginsdk/pluginsdk.go`, which imports nothing from `api/` or `db/`):

```go
package server

import (
	"context"

	"github.com/go-live-cms/go-live-cms/pluginsdk"
)

func init() {
	pluginsdk.Register("reading-time", pluginsdk.Plugin{
		Observers: map[string]pluginsdk.Observer{
			pluginsdk.EventPostPublished: func(ctx context.Context, host pluginsdk.Host, e pluginsdk.Event) error {
				post, err := host.Posts().GetPublished(ctx, e.PostID) // needs "posts:read"
				if err != nil {
					return err
				}
				host.Log().Info("published", "post_id", post.ID)
				return nil
			},
		},
	})
}
```

- **Link it:** run `go run ./cmd/gen-plugins` and commit `api/plugins_gen.go` (CI runs `--check`).
  Go has no runtime loading, so hooks are compiled into the API image.
- **Declare it:** every hook in Go must be in `server.hooks`, and every declared hook must be in Go.
  If they differ the plugin is listed as `incompatible` (`incompatible_reason: "hooks"`) and can't
  be enabled. A guard (`post.before_publish`) can't be implemented yet (#459).
- **Events:** `post.saved` (created, a body store or a settings save; coalesced, so read the post
  when the hook runs), `post.published` (also an Update; `ActorID` is who it's credited to),
  `post.unpublished`, `post.trashed`, `post.restored`, `post.deleted` (the post is gone; `Data`
  has `post_type`). The database writes them in the transaction of the change, and only while an
  enabled plugin subscribes.
- **How they run:** after the change committed, outside any transaction, as the system. At least
  once (`Event.ID` is the idempotency key), in order per post. An error, panic or timeout
  (`timeout_ms`, default 10s, at most 30s) is retried with backoff, at most 8 attempts, and
  `plugin_hook_failed` goes to the activity log (throttled; a run given up for good always is).
  Runs for a hook an upgrade drops are skipped. Two run at a time per plugin; a hook that ignores
  its context holds its slot until it returns. A hook can never fail, slow or roll back a publish.
- **Read-only.** `Host` gives the plugin's settings, a logger, and a reader per declared capability
  (`posts:read`, `media:read`, `users:read`; nil otherwise). Nothing writes a post: only the collab
  server writes `block_doc`.
