-- name: GetSettings :one
SELECT * FROM settings WHERE id = 1;

-- name: UpdateSettings :one
UPDATE settings
SET 
  post_url_structure = COALESCE(sqlc.narg('post_url_structure'), post_url_structure),
  site_title = COALESCE(sqlc.narg('site_title'), site_title),
  posts_per_page = COALESCE(sqlc.narg('posts_per_page'), posts_per_page),
  changed_at = now()
WHERE id = 1
RETURNING *;

-- name: GetExtensionSetting :one
SELECT * FROM extension_settings WHERE key = $1;

-- name: ListExtensionSettings :many
SELECT * FROM extension_settings
ORDER BY extension_type, extension_id, key;

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

-- name: DeleteExtensionSetting :exec
DELETE FROM extension_settings WHERE key = $1;

-- name: DeleteExtensionSettingsByExtension :exec
DELETE FROM extension_settings 
WHERE extension_type = $1 AND extension_id = $2;
