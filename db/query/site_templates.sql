-- Block templates and template parts (#490, docs/design/theme-builder.md 5.1, 7). The
-- collab server reaches the working copy through the API's internal listener
-- (GET/PUT /internal/site-templates/:id/collab); the writes run together in
-- StoreSiteTemplateCollabTx, as post_collab.sql's do in StorePostCollabTx.

-- name: CreateSiteTemplate :one
-- "Customize" or "New template" (POST /site-design/templates): the only writer of
-- block_doc besides the collab store, for a row with no Yjs state yet (rule 11).
INSERT INTO site_templates (theme_slug, kind, slug, title, block_doc, source, source_hash, created_by)
VALUES (@theme_slug, @kind, @slug, @title, @block_doc, @source, @source_hash, sqlc.narg(created_by))
RETURNING *;

-- name: GetSiteTemplate :one
SELECT * FROM site_templates WHERE id = $1;

-- name: GetSiteTemplateBySlug :one
SELECT * FROM site_templates WHERE theme_slug = @theme_slug AND kind = @kind AND slug = @slug;

-- name: GetSiteTemplateCollab :one
SELECT
    t.kind,
    t.block_doc,
    t.block_revision,
    s.state AS ydoc_state,
    s.epoch AS ydoc_epoch,
    s.block_revision AS ydoc_block_revision
FROM site_templates t
LEFT JOIN site_template_ydoc_state s ON s.template_id = t.id
WHERE t.id = $1;

-- name: LockSiteTemplateForCollabStore :one
SELECT block_revision
FROM site_templates
WHERE id = $1
FOR UPDATE;

-- name: UpdateSiteTemplateBlockDocFromCollab :one
-- Only stores that carry a block_doc reach this query (the collab server sends one only
-- when the derived doc changed), so state-only stores leave changed_at alone, as for posts.
UPDATE site_templates
SET block_doc = $2,
    block_revision = block_revision + 1,
    changed_at = now()
WHERE id = $1
RETURNING block_revision;

-- name: UpsertSiteTemplateYdocState :exec
-- A last_editor_id that no longer exists is stored as NULL rather than failing the store.
INSERT INTO site_template_ydoc_state (template_id, state, epoch, block_revision, last_editor_id, changed_at)
VALUES (
    @template_id, @state, @epoch, @block_revision,
    (SELECT u.id FROM users u WHERE u.id = sqlc.narg(last_editor_id)::bigint),
    now()
)
ON CONFLICT (template_id) DO UPDATE
SET state = EXCLUDED.state,
    epoch = EXCLUDED.epoch,
    block_revision = EXCLUDED.block_revision,
    last_editor_id = EXCLUDED.last_editor_id,
    changed_at = EXCLUDED.changed_at;

-- Publish, history, reset and restore (#492, docs/design/theme-builder.md 5.3, 8, 9).

-- name: ListSiteTemplatesByTheme :many
SELECT * FROM site_templates WHERE theme_slug = $1 ORDER BY kind, slug;

-- name: LockSiteTemplatesByTheme :many
-- PublishSiteDesignTx's lock on every row of the theme, in id order (one order for every
-- locker), so the rows it validated can't change under it.
SELECT * FROM site_templates WHERE theme_slug = $1 ORDER BY id FOR UPDATE;

-- name: NextSiteTemplateVersionNo :one
SELECT (COALESCE(MAX(version_no), 0) + 1)::int AS version_no
FROM site_template_versions
WHERE template_id = $1;

-- name: CreateSiteTemplateVersion :one
-- block_doc NULL: this release reset the item to the theme's default (section 9).
INSERT INTO site_template_versions (template_id, release_id, version_no, block_doc)
VALUES (@template_id, @release_id, @version_no, sqlc.narg(block_doc))
RETURNING *;

-- name: SetSiteTemplatePublished :one
-- The published side only: block_doc (the working copy) is the collab server's (rule 11).
UPDATE site_templates
SET published_block_doc = sqlc.narg(published_block_doc),
    published_version_id = @published_version_id
WHERE id = @id
RETURNING *;

-- name: SetSiteTemplateWorkingState :one
-- Reset to theme default and Keep editing (section 9): never block_doc.
UPDATE site_templates
SET working_state = @working_state,
    changed_at = now()
WHERE id = @id
RETURNING *;

-- name: SetSiteTemplateSource :one
-- "Start over from the theme default" after the editor replaced the working copy (rule 9):
-- where it starts from now, so "Default changed since you customized" clears.
UPDATE site_templates
SET source = @source,
    source_hash = @source_hash,
    working_state = 'custom',
    changed_at = now()
WHERE id = @id
RETURNING *;

-- name: DeleteUnpublishedSiteTemplate :execrows
-- Delete (section 9) removes only a row with no published override; its versions and Yjs
-- state cascade. 0 rows: gone, or published (by a publish that got there first).
DELETE FROM site_templates WHERE id = $1 AND published_block_doc IS NULL;

-- name: ListSiteTemplateVersions :many
SELECT
    v.id,
    v.template_id,
    v.release_id,
    v.version_no,
    (v.block_doc IS NULL)::bool AS reset,
    v.created_at,
    r.published_by,
    COALESCE(u.full_name, '')::varchar AS published_by_name
FROM site_template_versions v
JOIN site_design_releases r ON r.id = v.release_id
LEFT JOIN users u ON u.id = r.published_by
WHERE v.template_id = $1
ORDER BY v.version_no DESC
LIMIT 200;

-- name: GetSiteTemplateVersion :one
SELECT * FROM site_template_versions WHERE template_id = @template_id AND version_no = @version_no;

-- name: GetSiteTemplateVersionByID :one
SELECT * FROM site_template_versions WHERE id = $1;

-- name: ListSiteTemplateVersionsByRelease :many
-- The items of a page of releases (History), with what each item is now.
SELECT
    v.release_id,
    v.template_id,
    v.version_no,
    (v.block_doc IS NULL)::bool AS reset,
    t.kind,
    t.slug,
    t.title
FROM site_template_versions v
JOIN site_templates t ON t.id = v.template_id
WHERE v.release_id = ANY(@release_ids::bigint[])
ORDER BY v.release_id DESC, t.kind, t.slug;

-- name: ListPublishedSiteTemplateVersionNos :many
-- The published version number of each of a theme's rows (the overview, one query).
SELECT t.id, v.version_no
FROM site_templates t
JOIN site_template_versions v ON v.id = t.published_version_id
WHERE t.theme_slug = $1;

-- name: ListPublishedSiteTemplatesForResolve :many
-- The published copies the public site renders (#491, GET /public/site-templates/resolve):
-- the theme's published templates among the asked slugs, and every published part of the
-- theme. Never a working copy: published_block_doc is written only by publish (#492), and a
-- reset one is NULL, so it isn't here and the theme's default renders.
SELECT kind, slug, title, published_block_doc
FROM site_templates
WHERE theme_slug = @theme_slug
  AND published_block_doc IS NOT NULL
  AND (kind = 'part' OR (kind = 'template' AND slug = ANY(@slugs::varchar[])))
ORDER BY kind, slug;

-- name: ListPublishedCustomPageTemplates :many
-- The builder page templates a page may pick (#494, design 10): the theme's published
-- custom-<name> templates. A reset or never-published one has no published copy, so it
-- isn't offered (a page that already stores it keeps the name and renders the default).
SELECT slug, title
FROM site_templates
WHERE theme_slug = @theme_slug
  AND kind = 'template'
  AND slug LIKE 'custom-%'
  AND published_block_doc IS NOT NULL
ORDER BY lower(title), slug;
