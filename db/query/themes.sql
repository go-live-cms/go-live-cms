-- name: CreateTheme :one
INSERT INTO themes (
  name,
  slug,
  description,
  version,
  author,
  config,
  active
) VALUES (
  $1, $2, $3, $4, $5, $6, $7
) RETURNING *;

-- name: GetTheme :one
SELECT * FROM themes WHERE id = $1 LIMIT 1;

-- name: GetThemeBySlug :one
SELECT * FROM themes WHERE slug = $1 LIMIT 1;

-- name: GetActiveTheme :one
SELECT * FROM themes WHERE active = true LIMIT 1;

-- name: ListThemes :many
SELECT * FROM themes
ORDER BY active DESC, name ASC;

-- name: DeactivateAllThemes :exec
-- First deactivate all themes
UPDATE themes
SET 
  active = false,
  changed_at = now()
WHERE active = true;

-- name: ActivateTheme :one
-- Then activate the specified theme
UPDATE themes
SET 
  active = true,
  changed_at = now()
WHERE id = $1
RETURNING *;

-- name: UpdateTheme :one
UPDATE themes
SET 
  name = COALESCE(sqlc.narg('name'), name),
  description = COALESCE(sqlc.narg('description'), description),
  version = COALESCE(sqlc.narg('version'), version),
  author = COALESCE(sqlc.narg('author'), author),
  config = COALESCE(sqlc.narg('config'), config),
  changed_at = now()
WHERE themes.id = sqlc.arg('id')
RETURNING *;

-- name: DeleteTheme :exec
DELETE FROM themes WHERE id = $1;

-- Theme Settings Queries

-- name: GetThemeSetting :one
SELECT * FROM theme_settings 
WHERE theme_id = $1 AND setting_key = $2 
LIMIT 1;

-- name: ListThemeSettings :many
SELECT * FROM theme_settings
WHERE theme_id = $1
ORDER BY setting_key;

-- name: UpsertThemeSetting :one
INSERT INTO theme_settings (theme_id, setting_key, setting_value)
VALUES ($1, $2, $3)
ON CONFLICT (theme_id, setting_key) DO UPDATE
SET setting_value = EXCLUDED.setting_value,
    changed_at = now()
RETURNING *;

-- name: DeleteThemeSetting :exec
DELETE FROM theme_settings 
WHERE theme_id = $1 AND setting_key = $2;

-- name: DeleteAllThemeSettings :exec
DELETE FROM theme_settings WHERE theme_id = $1;

-- Get active theme with its settings
-- name: GetActiveThemeWithSettings :one
SELECT 
  t.*,
  COALESCE(
    jsonb_object_agg(ts.setting_key, ts.setting_value) FILTER (WHERE ts.id IS NOT NULL),
    '{}'::jsonb
  ) as settings
FROM themes t
LEFT JOIN theme_settings ts ON t.id = ts.theme_id
WHERE t.active = true
GROUP BY t.id
LIMIT 1;
