-- Older/newer and related posts for the public post page (#351).

-- name: ListAdjacentPosts :many
-- The published posts of @post_type just before ('previous', older) and just after
-- ('next', newer) the current one by publish date (created_at), ties broken on id
-- so two posts published in the same instant still have one order. Zero, one or two
-- rows. Each branch is one step along idx_posts_published_type_created_id (000023).
WITH adjacent AS (
    (
        SELECT 'previous'::text AS direction, p.id
        FROM posts p
        WHERE p.post_status = 'published'
            AND p.post_type = @post_type::text
            AND (p.created_at, p.id) < (@created_at::timestamptz, @post_id::bigint)
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT 1
    )
    UNION ALL
    (
        SELECT 'next'::text AS direction, p.id
        FROM posts p
        WHERE p.post_status = 'published'
            AND p.post_type = @post_type::text
            AND (p.created_at, p.id) > (@created_at::timestamptz, @post_id::bigint)
        ORDER BY p.created_at ASC, p.id ASC
        LIMIT 1
    )
)
SELECT
    a.direction,
    p.id, p.title, p.description, p.user_id, p.username, p.url,
    p.post_type, p.post_status, p.post_parent, p.menu_order, p.created_at, p.changed_at, p.slug,
    (
        SELECT COALESCE(jsonb_object_agg(pm.meta_key, pm.meta_value), '{}'::jsonb)
        FROM post_meta pm
        WHERE pm.post_id = p.id
    )::jsonb as meta,
    (
        SELECT COALESCE(
            jsonb_agg(jsonb_build_object('id', u.id, 'username', u.username, 'full_name', u.full_name) ORDER BY up."order", u.id),
            '[]'::jsonb
        )
        FROM user_posts up
        JOIN users u ON u.id = up.user_id
        WHERE up.post_id = p.id
    )::jsonb as authors
FROM adjacent a
JOIN posts p ON p.id = a.id;

-- name: ListRelatedPosts :many
-- Up to @limit_count published posts of @post_type ranked by the terms they share
-- with @post_id: shared categories first, then shared terms of every other taxonomy
-- (tags), then newest first (id breaks ties). @taxonomy limits which of the current
-- post's terms count ('' = all), and @term_id to one of them (0 = all; the sidebar's
-- "In <category>" names one category). With @with_fallback the latest posts fill the rest
-- when fewer share a term; without it only posts sharing one are returned. The
-- current post never appears.
--
-- The candidates are the posts sharing a term (unique_post_taxonomy_term for the
-- current post's terms, idx_post_taxonomy_term_id for the posts in them) plus the
-- latest @limit_count published posts (idx_posts_published_type_created_id), so the
-- ranking never scans the whole posts table. Those are enough: if fewer than
-- @limit_count published posts share a term, the latest ones fill the gap.
WITH current_terms AS (
    SELECT ptr.taxonomy_term_id, (ty.name = 'category') AS is_category
    FROM post_taxonomy_relationships ptr
    JOIN taxonomy_terms tt ON tt.id = ptr.taxonomy_term_id
    JOIN taxonomy_types ty ON ty.id = tt.taxonomy_type_id
    WHERE ptr.post_id = @post_id::bigint
        AND (@taxonomy::text = '' OR ty.name = @taxonomy::text)
        AND (@term_id::bigint = 0 OR ptr.taxonomy_term_id = @term_id::bigint)
),
shared AS (
    SELECT
        ptr.post_id,
        count(*) FILTER (WHERE ct.is_category) AS shared_categories,
        count(*) FILTER (WHERE NOT ct.is_category) AS shared_tags
    FROM post_taxonomy_relationships ptr
    JOIN current_terms ct ON ct.taxonomy_term_id = ptr.taxonomy_term_id
    WHERE ptr.post_id <> @post_id::bigint
    GROUP BY ptr.post_id
),
latest AS (
    SELECT lp.id
    FROM posts lp
    WHERE @with_fallback::boolean
        AND lp.post_status = 'published'
        AND lp.post_type = @post_type::text
        AND lp.id <> @post_id::bigint
    ORDER BY lp.created_at DESC, lp.id DESC
    LIMIT @limit_count::int
)
SELECT
    p.id, p.title, p.description, p.user_id, p.username, p.url,
    p.post_type, p.post_status, p.post_parent, p.menu_order, p.created_at, p.changed_at, p.slug,
    COALESCE(s.shared_categories, 0)::int AS shared_categories,
    COALESCE(s.shared_tags, 0)::int AS shared_tags,
    (
        SELECT COALESCE(jsonb_object_agg(pm.meta_key, pm.meta_value), '{}'::jsonb)
        FROM post_meta pm
        WHERE pm.post_id = p.id
    )::jsonb as meta,
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
LEFT JOIN shared s ON s.post_id = p.id
WHERE p.id IN (SELECT shared.post_id FROM shared UNION SELECT latest.id FROM latest)
    AND p.post_status = 'published'
    AND p.post_type = @post_type::text
    AND p.id <> @post_id::bigint
ORDER BY shared_categories DESC, shared_tags DESC, p.created_at DESC, p.id DESC
LIMIT @limit_count::int;
