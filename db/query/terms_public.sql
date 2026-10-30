-- Public term archives (#348): /{taxonomy}/{slug}, e.g. /category/guides. A term
-- has a page when its taxonomy type is public; its list is the published posts of
-- public, active post types tagged with the term or, for a hierarchical taxonomy,
-- any term below it (a parent category's page includes its children's posts). The
-- subtree is a recursive CTE over parent_id; UNION (not UNION ALL) drops repeats,
-- so even a parent cycle ends.

-- name: GetPublicTerm :one
-- The term of a public taxonomy by type name and slug, with the type's label.
SELECT
    tt.id, tt.name, tt.slug, tt.description, tt.parent_id,
    ttype.name AS taxonomy_name, ttype.label AS taxonomy_label, ttype.hierarchical
FROM taxonomy_terms tt
JOIN taxonomy_types ttype ON ttype.id = tt.taxonomy_type_id
WHERE ttype.name = @taxonomy AND tt.slug = @slug AND ttype.public
LIMIT 1;

-- name: CountPublishedPostsByTerm :one
-- The archive's total, with the same filters as ListPublishedPostsByTerm.
WITH RECURSIVE subtree AS (
    SELECT t.id FROM taxonomy_terms t WHERE t.id = @term_id
    UNION
    SELECT c.id FROM taxonomy_terms c JOIN subtree s ON c.parent_id = s.id
)
SELECT COUNT(*)::bigint AS total
FROM posts p
JOIN post_types pt ON pt.name = p.post_type
WHERE p.post_status = 'published'
    AND pt.public AND pt.is_active
    AND EXISTS (
        SELECT 1 FROM post_taxonomy_relationships ptr
        JOIN subtree s ON s.id = ptr.taxonomy_term_id
        WHERE ptr.post_id = p.id
    );

-- name: ListPublishedPostsByTerm :many
-- One page of the archive, newest first. Same columns as ListPostsWithMeta so rows
-- share its presenter. A post in both a parent and its child is listed once.
WITH RECURSIVE subtree AS (
    SELECT t.id FROM taxonomy_terms t WHERE t.id = @term_id
    UNION
    SELECT c.id FROM taxonomy_terms c JOIN subtree s ON c.parent_id = s.id
)
SELECT
    p.id, p.title, p.description, p.user_id, p.username, p.url,
    p.post_type, p.post_status, p.post_parent, p.menu_order, p.created_at, p.changed_at, p.published_block_doc, p.slug,
    (
        SELECT COALESCE(jsonb_object_agg(pm.meta_key, pm.meta_value), '{}'::jsonb)
        FROM post_meta pm
        WHERE pm.post_id = p.id
    ) as meta,
    (
        SELECT COALESCE(
            jsonb_agg(jsonb_build_object('id', u.id, 'username', u.username, 'full_name', u.full_name) ORDER BY up."order", u.id),
            '[]'::jsonb
        )
        FROM user_posts up
        JOIN users u ON u.id = up.user_id
        WHERE up.post_id = p.id
    )::jsonb as authors
FROM posts p
JOIN post_types pt ON pt.name = p.post_type
WHERE p.post_status = 'published'
    AND pt.public AND pt.is_active
    AND EXISTS (
        SELECT 1 FROM post_taxonomy_relationships ptr
        JOIN subtree s ON s.id = ptr.taxonomy_term_id
        WHERE ptr.post_id = p.id
    )
ORDER BY p.created_at DESC, p.id DESC
LIMIT @limit_count
OFFSET @offset_count;

-- name: ListPublicTerms :many
-- Every term page with at least one post (its own or a descendant's), for the
-- sitemap; lastmod is the newest of those posts. closure pairs each term with
-- itself and every term below it.
WITH RECURSIVE closure AS (
    SELECT t.id AS ancestor_id, t.id AS term_id FROM taxonomy_terms t
    UNION
    SELECT c.ancestor_id, t.id FROM closure c JOIN taxonomy_terms t ON t.parent_id = c.term_id
)
SELECT
    ttype.name AS taxonomy_name,
    a.slug,
    MAX(GREATEST(p.changed_at, p.created_at))::timestamptz AS last_modified
FROM closure c
JOIN taxonomy_terms a ON a.id = c.ancestor_id
JOIN taxonomy_types ttype ON ttype.id = a.taxonomy_type_id
JOIN post_taxonomy_relationships ptr ON ptr.taxonomy_term_id = c.term_id
JOIN posts p ON p.id = ptr.post_id
JOIN post_types pt ON pt.name = p.post_type
WHERE ttype.public
    AND p.post_status = 'published'
    AND pt.public AND pt.is_active
GROUP BY a.id, ttype.name, a.slug
ORDER BY a.id
LIMIT @limit_count
OFFSET @offset_count;
