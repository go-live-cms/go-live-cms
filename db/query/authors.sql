-- Public author pages (#350). An author is a user credited (user_posts, the
-- byline) on at least one published post of a public, active post type: the
-- posts the public site serves. Nobody else has a page, so these queries are
-- the only place that rule lives.

-- name: GetPublicAuthor :one
-- The author's public fields and how many of those posts credit them. A user
-- with none gets post_count 0, which the API answers like an unknown username.
SELECT
    u.id, u.username, u.full_name, u.bio, u.website,
    (
        SELECT COUNT(*)
        FROM user_posts up
        JOIN posts p ON p.id = up.post_id
        JOIN post_types pt ON pt.name = p.post_type
        WHERE up.user_id = u.id
            AND p.post_status = 'published'
            AND pt.public AND pt.is_active
    )::bigint AS post_count
FROM users u
WHERE u.username = $1
LIMIT 1;

-- name: ListPublishedPostsByAuthor :many
-- The author page's list, newest first. Same columns as ListPostsWithMeta so
-- rows share its presenter.
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
            jsonb_agg(jsonb_build_object('id', u.id, 'username', u.username, 'full_name', u.full_name) ORDER BY up2."order", u.id),
            '[]'::jsonb
        )
        FROM user_posts up2
        JOIN users u ON u.id = up2.user_id
        WHERE up2.post_id = p.id
    )::jsonb as authors
FROM posts p
JOIN post_types pt ON pt.name = p.post_type
WHERE p.post_status = 'published'
    AND pt.public AND pt.is_active
    AND EXISTS (SELECT 1 FROM user_posts up WHERE up.post_id = p.id AND up.user_id = @user_id)
ORDER BY p.created_at DESC, p.id DESC
LIMIT @limit_count
OFFSET @offset_count;

-- name: ListPostAuthorProfiles :many
-- The "Written by" cards: every author credited on a post, in byline order.
-- Empty unless the post is one the public site serves, so it never shows who
-- wrote a draft, and every author it returns has a page.
SELECT u.id, u.username, u.full_name, u.bio, u.website
FROM user_posts up
JOIN users u ON u.id = up.user_id
JOIN posts p ON p.id = up.post_id
JOIN post_types pt ON pt.name = p.post_type
WHERE up.post_id = $1
    AND p.post_status = 'published'
    AND pt.public AND pt.is_active
ORDER BY up."order", u.id;

-- name: ListPublicAuthors :many
-- Every author with a page, for the sitemap; lastmod is their newest post's.
SELECT
    u.username,
    MAX(GREATEST(p.changed_at, p.created_at))::timestamptz AS last_modified
FROM users u
JOIN user_posts up ON up.user_id = u.id
JOIN posts p ON p.id = up.post_id
JOIN post_types pt ON pt.name = p.post_type
WHERE p.post_status = 'published'
    AND pt.public AND pt.is_active
GROUP BY u.id, u.username
ORDER BY u.id
LIMIT @limit_count
OFFSET @offset_count;
