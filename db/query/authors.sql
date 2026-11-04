-- Public author pages (#350). An author is a user credited in the published
-- byline (post_published_authors, the snapshot's author_ids, #319) of at least one
-- published post of a public, active post type: the posts the public site serves.
-- A byline edit not yet published credits nobody. Nobody else has a page, so
-- these queries are the only place that rule lives.

-- name: GetPublicAuthor :one
-- The author's public fields and how many of those posts credit them. A user
-- with none gets post_count 0, which the API answers like an unknown username.
SELECT
    u.id, u.username, u.full_name, u.bio, u.website,
    (
        SELECT COUNT(*)
        FROM post_published_authors ppa
        JOIN posts p ON p.id = ppa.post_id
        JOIN post_types pt ON pt.name = p.post_type
        WHERE ppa.user_id = u.id
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
    p.post_type, p.post_status, p.post_parent, p.menu_order, p.created_at, p.changed_at, p.published_block_doc, p.slug, p.published_settings,
    -- ListPostsWithMeta's column (#326); the public site never shows it.
    false::boolean AS has_unpublished_changes,
    p.publish_at,
    p.deleted_at, p.trashed_from_status,
    -- ListPostsWithMeta's scheduled update (#335): the admin's business.
    NULL::timestamptz AS update_at,
    (
        SELECT COALESCE(jsonb_object_agg(pm.meta_key, pm.meta_value), '{}'::jsonb)
        FROM post_meta pm
        WHERE pm.post_id = p.id
    ) as meta,
    golive_post_published_byline(p.id)::jsonb as authors

FROM posts p
JOIN post_types pt ON pt.name = p.post_type
WHERE p.post_status = 'published'
    AND pt.public AND pt.is_active
    AND EXISTS (SELECT 1 FROM post_published_authors ppa WHERE ppa.post_id = p.id AND ppa.user_id = @user_id)
ORDER BY p.created_at DESC, p.id DESC
LIMIT @limit_count
OFFSET @offset_count;

-- name: ListPostAuthorProfiles :many
-- The "Written by" cards: every author in the post's published byline, in
-- order. Empty unless the post is one the public site serves, so it never shows
-- who wrote a draft, and every author it returns has a page.
SELECT u.id, u.username, u.full_name, u.bio, u.website
FROM post_published_authors up
JOIN users u ON u.id = up.user_id
JOIN posts p ON p.id = up.post_id
JOIN post_types pt ON pt.name = p.post_type
WHERE up.post_id = $1
    AND p.post_status = 'published'
    AND pt.public AND pt.is_active
ORDER BY up.position, u.id;

-- name: ListPublicAuthors :many
-- Every author with a page, for the sitemap; lastmod is their newest post's.
SELECT
    u.username,
    MAX(GREATEST(p.changed_at, p.created_at))::timestamptz AS last_modified
FROM users u
JOIN post_published_authors up ON up.user_id = u.id
JOIN posts p ON p.id = up.post_id
JOIN post_types pt ON pt.name = p.post_type
WHERE p.post_status = 'published'
    AND pt.public AND pt.is_active
GROUP BY u.id, u.username
ORDER BY u.id
LIMIT @limit_count
OFFSET @offset_count;
