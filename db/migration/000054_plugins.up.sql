-- The plugin registry (#455, docs/design/plugin-system.md section 4.1).
--
-- One row per plugin directory the API has ever found under web/plugins/<slug>/. The
-- startup scan (api/themes_scanner.go, SyncPluginsToDatabase) upserts rows and never
-- deletes one: a plugin gone from the build becomes status 'missing' and keeps
-- `enabled` and its settings (extension_settings, extension_type 'plugin'), so a
-- rollback or a later deploy that brings it back restores it as it was.
--
-- `id` is numeric because activity.object_id is a bigint (#324); `slug` is the
-- directory name and the manifest's `id`. `manifest` is plugin.json as validated.
-- `content_hash` is the SHA-256 over the plugin's files: what exactly is installed,
-- and the value a package signature will sign later.
--
-- A new plugin starts disabled. 'incompatible' means its manifest is outside core's
-- plugin_api range, or no longer validates: it can't be enabled (EnablePlugin's
-- WHERE), and an enabled one keeps the flag but doesn't run.
CREATE TABLE "plugins" (
  "id"           bigserial PRIMARY KEY,
  "slug"         varchar NOT NULL UNIQUE
                 CONSTRAINT "plugins_slug_format" CHECK ("slug" ~ '^[a-z][a-z0-9-]{0,62}$'),
  "name"         varchar NOT NULL,
  "version"      varchar NOT NULL,
  "author"       varchar NOT NULL DEFAULT '',
  "description"  text    NOT NULL DEFAULT '',
  "manifest"     jsonb   NOT NULL
                 CONSTRAINT "plugins_manifest_object" CHECK (jsonb_typeof("manifest") = 'object'),
  "content_hash" varchar NOT NULL
                 CONSTRAINT "plugins_content_hash_format" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  "status"       varchar NOT NULL DEFAULT 'installed'
                 CONSTRAINT "plugins_status" CHECK ("status" IN ('installed', 'missing', 'incompatible')),
  "enabled"      boolean NOT NULL DEFAULT false,
  "enabled_at"   timestamptz,
  "enabled_by"   bigint REFERENCES "users" ("id") ON DELETE SET NULL,
  "installed_at" timestamptz NOT NULL DEFAULT now(),
  "changed_at"   timestamptz NOT NULL DEFAULT now()
);
