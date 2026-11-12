-- name: GetSettings :one
SELECT * FROM settings WHERE id = 1;

-- name: UpdateSettings :one
UPDATE settings
SET 
  post_url_structure = COALESCE(sqlc.narg('post_url_structure'), post_url_structure),
  site_title = COALESCE(sqlc.narg('site_title'), site_title),
  posts_per_page = COALESCE(sqlc.narg('posts_per_page'), posts_per_page),
  site_tagline = COALESCE(sqlc.narg('site_tagline'), site_tagline),
  site_language = COALESCE(sqlc.narg('site_language'), site_language),
  site_timezone = COALESCE(sqlc.narg('site_timezone'), site_timezone),
  date_format = COALESCE(sqlc.narg('date_format'), date_format),
  editor_markdown_shortcuts = COALESCE(sqlc.narg('editor_markdown_shortcuts'), editor_markdown_shortcuts),
  allow_signup = COALESCE(sqlc.narg('allow_signup'), allow_signup),
  -- A nil slice is NULL (keep); an empty one clears the list.
  editor_allowed_embeds = COALESCE(sqlc.narg('editor_allowed_embeds')::text[], editor_allowed_embeds),
  -- The front page (#336): set_front_page says whether the request names one;
  -- front_page_id NULL then means "the latest posts".
  front_page_id = CASE WHEN sqlc.arg('set_front_page')::boolean THEN sqlc.narg('front_page_id')::bigint ELSE front_page_id END,
  changed_at = now()
WHERE id = 1
RETURNING *;

-- name: GetPublicFrontPage :one
-- The page the public site renders at / (#336): the settings' front page while it is
-- a published page of an active, public type. No row: / shows the latest posts.
SELECT * FROM posts
WHERE id = (SELECT s.front_page_id FROM settings s WHERE s.id = 1)
  AND post_type = 'page'
  AND post_status = 'published'
  AND EXISTS (SELECT 1 FROM post_types pt WHERE pt.name = 'page' AND pt.public AND pt.is_active);

-- The public /extension-settings routes read through these two, so a plugin's
-- row can't reach them (#451). Plugins get their own admin-only reads.

-- name: GetThemeExtensionSetting :one
SELECT * FROM extension_settings
WHERE key = $1 AND extension_type = 'theme';

-- name: ListThemeExtensionSettings :many
SELECT * FROM extension_settings
WHERE extension_type = 'theme'
ORDER BY extension_id, key;

-- name: ListExtensionSettingsByExtension :many
SELECT * FROM extension_settings
WHERE extension_type = $1 AND extension_id = $2
ORDER BY key;

-- name: UpsertExtensionSetting :one
INSERT INTO extension_settings (key, value, extension_type, extension_id)
VALUES ($1, $2, $3, $4)
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value,
    changed_at = now()
RETURNING *;

-- name: DeleteThemeExtensionSetting :execrows
DELETE FROM extension_settings
WHERE key = $1 AND extension_type = 'theme';

-- name: DeleteExtensionSettingsByExtension :exec
DELETE FROM extension_settings 
WHERE extension_type = $1 AND extension_id = $2;

-- Plugin settings (#457, docs/design/plugin-system.md section 6): rows keyed
-- plugin:<slug>:<name>, written only through the admin-only
-- /plugins/:slug/settings routes. Read with ListPluginExtensionSettings
-- (plugin_hooks.sql), which the hook host shares.

-- name: DeletePluginSetting :execrows
DELETE FROM extension_settings
WHERE key = $1 AND extension_type = 'plugin' AND extension_id = $2;

-- "Delete plugin data" (section 4.4): every row of this plugin, no other.
-- name: DeletePluginSettings :execrows
DELETE FROM extension_settings
WHERE extension_type = 'plugin' AND extension_id = $1;
