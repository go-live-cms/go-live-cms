# Plugins

Each directory here is one plugin: `web/plugins/<slug>/`, with a `plugin.json`. The design is
`docs/design/plugin-system.md`. The registry (#455): the manifest, the scan, and enable/disable.
Content blocks (#456): `blocks/<Name>/`, below. Settings (#457) and server hooks (#458) build on it.
`reading-time/` is the example plugin.

```
web/plugins/<slug>/
  plugin.json             # Required.
  README.md
  blocks/<Name>/          # One directory per name in "blocks".
    block.json            # The block's definition. Data only.
    editor.ts             # Admin only: node view + menu entry.
    render.tsx            # The public renderer.
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

## Content blocks (#456)

A block is `blocks/<Name>/`, listed in plugin.json's `blocks`. Its type, also its ProseMirror node
and Yjs element name, is **`plugin:<id>/<name in lowercase>`** (`blocks/Estimate/` of
`reading-time` is `plugin:reading-time/estimate`).

```json
{ "type": "plugin:reading-time/estimate", "version": 1, "title": "Reading time",
  "content": "", "attrs": { "label": { "type": "string", "default": "min read", "maxLength": 40 } } }
```

**`block.json`** holds exactly what a theme block's `defineThemeBlock` takes (`themes/README.md`,
"Custom Blocks"), as data: `type`, `version` (1 to 1000000), `title` (≤100), optional `content`
(a content expression over text and text blocks only, `inline` `text` `hardBreak` `paragraph`
`heading` `codeBlock` `horizontalRule`; default `inline*`, `""` = a leaf), `marks` and `attrs`
(`string` with `default`, `enum`, `maxLength`; `number` with `default`, `enum`, `integer`,
`minimum`, `maximum`; `boolean` with `default`; names not `pm`, `text` or `on…`). Unknown
fields are refused. One validator in Go (`api/plugin_blocks.go`) and its twin
(`web/gl-admin/lib/plugins/blockJson.ts`) share `pluginBlockVectors.json`.

Why JSON: the collab server bundles `block.json` and nothing else of a plugin (its build fails on
any other plugin file), and the API validates stored blocks from the same file without running
anything.

**`editor.ts`** default-exports `pluginBlockEditor(block, { nodeView, icon, group?, keywords? })`
(`@gl-admin/lib/plugins/editor`), importing its own `block.json`: a React node view and a block
menu entry, nothing else (no schema, no ProseMirror plugin). **`render.tsx`** default-exports the
public component (`BlockComponentProps`); read attrs with
`themeBlockAttrs(pluginBlockSpec(block), block.attrs)`. A renderer that throws renders nothing for
its block, logged as `plugin_block_render_failed`; keep it a pure function of its props (on the
server it renders twice).

What each state of the plugin does to its blocks (`docs/design/plugin-system.md` 4.4):

| | Enabled | Disabled | Removed from the build | Back in the build |
|---|---|---|---|---|
| In the editor and collab schema | yes | **yes** | no | yes |
| An existing block in the editor | edits | **edits** | hidden, kept | restored in place |
| Offered in the block menus | yes | no | no | if enabled |
| API on store | validated | validated | kept as is | validated |
| Public page | renders | **renders** | nothing | renders |

The schema is what is **installed**, never what is enabled, so enabling or disabling changes no
schema fingerprint and restarts nothing. Adding, changing or removing a block means rebuilding
the web, collab and api images from one commit. `GET /api/v1/plugins/<id>/usage` (admins) lists
the posts whose working copy or published page holds one of the plugin's blocks.

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
