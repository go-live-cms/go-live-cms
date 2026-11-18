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
  -- The site logo (#488): set_site_logo says whether the request names one;
  -- site_logo_media_id NULL then means none.
  site_logo_media_id = CASE WHEN sqlc.arg('set_site_logo')::boolean THEN sqlc.narg('site_logo_media_id')::bigint ELSE site_logo_media_id END,
  -- Settings > Discussion (#522, design 12.1).
  comments_enabled = COALESCE(sqlc.narg('comments_enabled'), comments_enabled),
  comments_moderation = COALESCE(sqlc.narg('comments_moderation'), comments_moderation),
  comments_max_links = COALESCE(sqlc.narg('comments_max_links'), comments_max_links),
  comments_hold_words = COALESCE(sqlc.narg('comments_hold_words')::text[], comments_hold_words),
  comments_spam_words = COALESCE(sqlc.narg('comments_spam_words')::text[], comments_spam_words),
  comments_close_after_days = COALESCE(sqlc.narg('comments_close_after_days'), comments_close_after_days),
  comments_threading = COALESCE(sqlc.narg('comments_threading'), comments_threading),
  comments_order = COALESCE(sqlc.narg('comments_order'), comments_order),
  comments_per_page = COALESCE(sqlc.narg('comments_per_page'), comments_per_page),
  comments_notice = COALESCE(sqlc.narg('comments_notice'), comments_notice),
  -- set_comments_privacy_page says whether the request names one; NULL then means none.
  comments_privacy_page_id = CASE WHEN sqlc.arg('set_comments_privacy_page')::boolean THEN sqlc.narg('comments_privacy_page_id')::bigint ELSE comments_privacy_page_id END,
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
