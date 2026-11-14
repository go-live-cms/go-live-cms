-- Global styles (#485, 000056, docs/design/theme-builder.md section 6). Written by the
-- site design routes (api/site_design_handlers.go); values are validated there first.

-- name: GetGlobalStyles :one
SELECT * FROM global_styles WHERE theme_slug = $1;

-- name: EnsureGlobalStyles :exec
-- The row a theme's first save updates. Idempotent.
INSERT INTO global_styles (theme_slug) VALUES ($1)
ON CONFLICT (theme_slug) DO NOTHING;

-- name: UpdateGlobalStylesDraft :one
-- Optimistic: no row when base_revision is stale (another admin saved since), and the
-- handler answers 409 styles_changed with the current draft.
UPDATE global_styles
SET draft = @draft,
    draft_revision = draft_revision + 1,
    changed_by = sqlc.narg(changed_by),
    changed_at = now()
WHERE theme_slug = @theme_slug AND draft_revision = @base_revision
RETURNING *;

-- name: GetGlobalStylesForUpdate :one
SELECT * FROM global_styles WHERE theme_slug = $1 FOR UPDATE;

-- name: CreateSiteDesignRelease :one
INSERT INTO site_design_releases (theme_slug, published_by, summary)
VALUES (@theme_slug, sqlc.narg(published_by), @summary)
RETURNING *;

-- name: NextGlobalStyleVersionNo :one
SELECT (COALESCE(MAX(version_no), 0) + 1)::int AS version_no
FROM global_style_versions
WHERE theme_slug = $1;

-- name: CreateGlobalStyleVersion :one
INSERT INTO global_style_versions (theme_slug, release_id, version_no, styles)
VALUES (@theme_slug, @release_id, @version_no, @styles)
RETURNING *;

-- name: SetPublishedGlobalStyles :one
UPDATE global_styles
SET published = @published,
    published_version_id = @published_version_id
WHERE theme_slug = @theme_slug
RETURNING *;
