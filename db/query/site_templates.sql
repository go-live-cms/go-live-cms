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
