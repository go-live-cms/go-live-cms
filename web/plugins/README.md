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
