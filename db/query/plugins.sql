-- The plugin registry (#455, 000054). The startup scan writes through the
-- *Discovered* / Mark* queries, the admin routes through Enable/Disable. Each write
-- is one conditional statement that returns a row only when it changed something,
-- so when several replicas scan at once exactly one of them records each change in
-- the activity log.

-- name: ListPlugins :many
SELECT * FROM plugins
ORDER BY lower(name), slug;

-- name: GetPluginBySlug :one
SELECT * FROM plugins
WHERE slug = @slug;

-- name: ListEnabledPluginSlugs :many
-- What the block menus offer (GET /plugins/enabled): enabled and in this build.
-- A missing or incompatible plugin keeps its flag but isn't running.
SELECT slug FROM plugins
WHERE enabled AND status = 'installed'
ORDER BY slug;

-- name: InsertDiscoveredPlugin :one
-- A plugin seen for the first time. It starts disabled. No row when another replica
-- inserted it first.
INSERT INTO plugins (slug, name, version, author, description, manifest, content_hash, status)
VALUES (@slug, @name, @version, @author, @description, @manifest, @content_hash, @status)
ON CONFLICT (slug) DO NOTHING
RETURNING *;

-- name: UpdateDiscoveredPlugin :one
-- A known plugin whose files or status changed since the last scan (an upgrade, a
-- return from 'missing', a change of compatibility). `enabled` is kept. No row when
-- nothing changed, including when another replica has just applied the same change:
-- prev's FOR UPDATE waits for it and the WHERE then sees its values.
WITH prev AS (
    SELECT cur.id, cur.version, cur.status FROM plugins cur
    WHERE cur.slug = @slug
    FOR UPDATE
)
UPDATE plugins p
SET name = @name,
    version = @version,
    author = @author,
    description = @description,
    manifest = @manifest,
    content_hash = @content_hash,
    status = @status,
    changed_at = now()
FROM prev
WHERE p.id = prev.id
  AND (p.content_hash <> @content_hash OR p.status <> @status)
RETURNING p.id, p.slug, p.version, p.status, prev.version AS previous_version, prev.status AS previous_status;

-- name: MarkPluginInvalid :one
-- A known plugin whose directory is there but whose plugin.json no longer validates:
-- incompatible, with the last valid manifest kept. No row when it already was, for
-- these files.
WITH prev AS (
    SELECT cur.id, cur.version, cur.status FROM plugins cur
    WHERE cur.slug = @slug
    FOR UPDATE
)
UPDATE plugins p
SET status = 'incompatible',
    content_hash = @content_hash,
    changed_at = now()
FROM prev
WHERE p.id = prev.id
  AND (p.status <> 'incompatible' OR p.content_hash <> @content_hash)
RETURNING p.id, p.slug, p.version, p.status, prev.status AS previous_status;

-- name: MarkMissingPlugins :many
-- Every plugin whose directory is gone from the build. Never a delete: the row keeps
-- `enabled`, and its settings stay in extension_settings.
UPDATE plugins
SET status = 'missing',
    changed_at = now()
WHERE status <> 'missing'
  AND NOT (slug = ANY(@present_slugs::varchar[]))
RETURNING *;

-- name: EnablePlugin :one
-- No row when the plugin isn't installed and compatible, or is already enabled.
UPDATE plugins
SET enabled = true,
    enabled_at = now(),
    enabled_by = @enabled_by,
    changed_at = now()
WHERE slug = @slug
  AND status = 'installed'
  AND NOT enabled
RETURNING *;

-- name: DisablePlugin :one
-- Allowed in any status: disabling is how an admin stops a misbehaving plugin, and
-- a missing one may come back. No row when it is already disabled.
UPDATE plugins
SET enabled = false,
    enabled_at = NULL,
    enabled_by = NULL,
    changed_at = now()
WHERE slug = @slug
  AND enabled
RETURNING *;

-- name: ListPostsUsingPluginBlocks :many
-- The posts whose working copy or published snapshot holds a block of one plugin (#456,
-- design 4.3): any node whose type starts with type_prefix (`plugin:<slug>/`), in the
-- flat blocks map or nested in a block's pm (a plugin block may sit in a quote). Every
-- status, the trash included: a trashed post still holds the block and may come back.
-- A full scan: admin-only and rare, so no index. `total` counts every match; the rows
-- stop at row_limit, most recently changed first.
SELECT p.id, p.title, p.post_type, p.post_status, p.changed_at,
       jsonb_path_exists(p.block_doc, '$.blocks.*.** ? (@.type starts with $prefix)',
                         jsonb_build_object('prefix', @type_prefix::text))::boolean AS in_working_copy,
       COALESCE(jsonb_path_exists(p.published_block_doc, '$.blocks.*.** ? (@.type starts with $prefix)',
                                  jsonb_build_object('prefix', @type_prefix::text)), false)::boolean AS in_published,
       COUNT(*) OVER ()::bigint AS total
FROM posts p
WHERE jsonb_path_exists(p.block_doc, '$.blocks.*.** ? (@.type starts with $prefix)',
                        jsonb_build_object('prefix', @type_prefix::text))
   OR COALESCE(jsonb_path_exists(p.published_block_doc, '$.blocks.*.** ? (@.type starts with $prefix)',
                                 jsonb_build_object('prefix', @type_prefix::text)), false)
ORDER BY p.changed_at DESC, p.id DESC
LIMIT @row_limit::int;
