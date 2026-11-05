-- Post templates (#322, 000043). A template is not a post: nothing in post.sql
-- or the public queries reads these tables.

-- name: CreatePostTemplate :one
INSERT INTO post_templates (post_type, name, block_doc, featured_media_id, created_by)
VALUES (
    @post_type,
    @name,
    @block_doc,
    -- The source's featured image (its order-0 post_media link), when the
    -- settings are saved too.
    CASE WHEN @with_settings::boolean THEN (
        SELECT pm.media_id FROM post_media pm
        WHERE pm.post_id = @source_post_id::bigint AND pm."order" = 0
        LIMIT 1
    ) END,
    sqlc.narg(created_by)
)
RETURNING *;

-- name: CopyPostCategoryTermsToTemplate :exec
-- The source's category terms (taxonomy "category"), the template's saved
-- category. Tags and other taxonomies describe one post, not a kind of post.
INSERT INTO post_template_terms (template_id, term_id)
SELECT @template_id::bigint, ptr.taxonomy_term_id
FROM post_taxonomy_relationships ptr
JOIN taxonomy_terms t ON t.id = ptr.taxonomy_term_id
JOIN taxonomy_types tt ON tt.id = t.taxonomy_type_id
WHERE ptr.post_id = @source_post_id::bigint AND tt.name = 'category'
ON CONFLICT DO NOTHING;

-- name: GetPostTemplate :one
SELECT * FROM post_templates WHERE id = $1;

-- name: ListPostTemplates :many
-- Without block_doc (the chooser doesn't need it), with the saved category's
-- names and who saved it. With id, that one template (the create and rename
-- responses).
SELECT
    t.id,
    t.post_type,
    t.name,
    t.featured_media_id,
    t.created_by,
    t.created_at,
    t.changed_at,
    COALESCE(u.full_name, '')::varchar AS created_by_name,
    COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', tt.id, 'name', tt.name) ORDER BY lower(tt.name), tt.id)
        FROM post_template_terms ptt
        JOIN taxonomy_terms tt ON tt.id = ptt.term_id
        WHERE ptt.template_id = t.id
    ), '[]'::jsonb)::jsonb AS terms
FROM post_templates t
LEFT JOIN users u ON u.id = t.created_by
WHERE (sqlc.narg(post_type)::varchar IS NULL OR t.post_type = sqlc.narg(post_type))
  AND (sqlc.narg(id)::bigint IS NULL OR t.id = sqlc.narg(id))
ORDER BY lower(t.name), t.id;

-- name: RenamePostTemplate :one
UPDATE post_templates
SET name = @name, changed_at = now()
WHERE id = @id
RETURNING *;

-- name: DeletePostTemplate :execrows
DELETE FROM post_templates WHERE id = $1;

-- name: CopyTemplateTermsToPost :exec
-- A post made from a template gets its saved category.
INSERT INTO post_taxonomy_relationships (post_id, taxonomy_term_id)
SELECT @new_post_id::bigint, ptt.term_id
FROM post_template_terms ptt
WHERE ptt.template_id = @template_id::bigint;
