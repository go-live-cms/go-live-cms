-- name: CreatePosts :one
INSERT INTO posts (
    title,
    description,
    user_id,
    username,
    url,
    post_type,
    post_status,
    post_parent,
    menu_order,
    slug,
    block_doc
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
) RETURNING *;

-- name: CreateUserPost :one
INSERT INTO user_posts (
    post_id,
    user_id,
    "order"
) VALUES (
    $1, $2, $3
) RETURNING *;

-- name: GetPost :one
SELECT * FROM posts 
WHERE id = $1 LIMIT 1;

-- name: GetPostBySlug :one
SELECT * FROM posts 
WHERE slug = $1 LIMIT 1;

-- name: CheckURLExists :one
SELECT EXISTS(SELECT 1 FROM posts WHERE url = $1) as exists;

-- name: CheckSlugExists :one
-- exclude_id skips the post being edited; pass 0 when creating.
SELECT EXISTS(SELECT 1 FROM posts WHERE slug = sqlc.arg(slug) AND id <> sqlc.arg(exclude_id)) as exists;

-- name: UpdatePostSlug :one
UPDATE posts
SET slug = $2,
    changed_at = now()
WHERE id = $1
RETURNING *;

-- name: GetPostWithMeta :one
SELECT 
    p.*,
    COALESCE(
        jsonb_object_agg(
            pm.meta_key, 
            pm.meta_value
        ) FILTER (WHERE pm.meta_key IS NOT NULL),
        '{}'::jsonb
    ) as meta
FROM posts p
LEFT JOIN post_meta pm ON p.id = pm.post_id
WHERE p.id = $1
GROUP BY p.id, p.title, p.description, p.published_block_doc, p.user_id, p.username, p.url, p.post_type, p.post_status, p.post_parent, p.menu_order, p.created_at, p.changed_at;

-- name: ListPosts :many
SELECT p.id, p.title, p.description, p.user_id, p.username, p.url, p.post_type, p.post_status, p.post_parent, p.menu_order, p.created_at, p.changed_at, p.published_block_doc, p.slug, p.published_settings,
    -- Changes not published (#326): a published post whose working copy (body or
    -- settings) differs from what the site shows. Migration 000030.
    golive_post_has_unpublished_changes(p.id, p.post_status, p.block_doc_hash, p.published_block_hash, p.published_settings)::boolean AS has_unpublished_changes,
    p.publish_at,
    -- The Trash tab (#327): when, and the status a restore brings back.
    p.deleted_at, p.trashed_from_status
FROM posts p
WHERE 
    (@post_type::text = '' OR p.post_type = @post_type)
    -- status: one status or a comma list; none = every status but the trash (#327).
    AND (CASE WHEN @post_status::text = '' THEN p.post_status <> 'trash'
              ELSE p.post_status = ANY(string_to_array(replace(@post_status::text, ' ', ''), ',')) END)
    -- Filters (#327): credited in the byline (user_posts), and linked to every term given.
    AND (@author_id::bigint = 0 OR EXISTS (SELECT 1 FROM user_posts fa WHERE fa.post_id = p.id AND fa.user_id = @author_id::bigint))
    AND NOT EXISTS (
        SELECT 1 FROM unnest(@term_ids::bigint[]) AS ft(id)
        WHERE NOT EXISTS (SELECT 1 FROM post_taxonomy_relationships fr WHERE fr.post_id = p.id AND fr.taxonomy_term_id = ft.id)
    )
    AND (@user_id::bigint = 0 OR p.user_id = @user_id)  -- Add user filter
    -- What the caller may read (#393): 0 = everything (moderators, /public); a
    -- contributor's id = their own posts plus published ones (canReadPost).
    AND (@viewer_id::bigint = 0 OR p.user_id = @viewer_id OR p.post_status = 'published')
    AND (NOT @unpublished_changes::boolean OR golive_post_has_unpublished_changes(p.id, p.post_status, p.block_doc_hash, p.published_block_hash, p.published_settings))
-- Whitelisted sort (#89): the API resolves sort_column/sort_direction to one
-- of these pairs; anything else falls through to the id tiebreaker.
-- changed_at sorts as GREATEST(changed_at, created_at): never-updated posts
-- keep the 0001-01-01 sentinel and rank by creation time instead.
ORDER BY
    CASE WHEN @sort_column::text = 'created_at' AND @sort_direction::text = 'asc' THEN created_at END ASC,
    CASE WHEN @sort_column::text = 'created_at' AND @sort_direction::text = 'desc' THEN created_at END DESC,
    CASE WHEN @sort_column::text = 'changed_at' AND @sort_direction::text = 'asc' THEN GREATEST(changed_at, created_at) END ASC,
    CASE WHEN @sort_column::text = 'changed_at' AND @sort_direction::text = 'desc' THEN GREATEST(changed_at, created_at) END DESC,
    CASE WHEN @sort_column::text = 'title' AND @sort_direction::text = 'asc' THEN title END ASC,
    CASE WHEN @sort_column::text = 'title' AND @sort_direction::text = 'desc' THEN title END DESC,
    CASE WHEN @sort_column::text = 'menu_order' AND @sort_direction::text = 'asc' THEN menu_order END ASC,
    CASE WHEN @sort_column::text = 'menu_order' AND @sort_direction::text = 'desc' THEN menu_order END DESC,
    -- Stable tiebreaker in the requested direction (also serves sort=id).
    CASE WHEN @sort_direction::text = 'asc' THEN id END ASC,
    id DESC
LIMIT @limit_count
OFFSET @offset_count;

-- name: GetPostChildren :many
SELECT * FROM posts
WHERE post_parent = $1
ORDER BY menu_order ASC, title ASC;

-- name: UpdatePost :one
UPDATE posts
SET title = COALESCE($1, title),
    description = COALESCE($2, description),
    user_id = COALESCE($3, user_id),
    username = COALESCE($4, username),
    url = COALESCE($5, url),
    post_type = COALESCE($6, post_type),
    -- 'scheduled' only ever stays (#147): the handler allows it unchanged, and if the
    -- scheduler published or someone cancelled meanwhile there is no time to keep, so
    -- the status the row has now stays (the publish_at CHECK would refuse it otherwise).
    post_status = CASE WHEN COALESCE($7, post_status) = 'scheduled' AND publish_at IS NULL THEN post_status ELSE COALESCE($7, post_status) END,
    post_parent = COALESCE($8, post_parent),
    menu_order = COALESCE($9, menu_order),
    -- Moving a scheduled post to another status ends its schedule (#147); only
    -- SchedulePost sets one (the handler refuses 'scheduled' here otherwise).
    publish_at = CASE WHEN COALESCE($7, post_status) = 'scheduled' THEN publish_at END,
    publish_scheduled_by = CASE WHEN COALESCE($7, post_status) = 'scheduled' THEN publish_scheduled_by END,
    publish_next_attempt_at = CASE WHEN COALESCE($7, post_status) = 'scheduled' THEN publish_next_attempt_at END,
    publish_failed_at = CASE WHEN COALESCE($7, post_status) = 'scheduled' THEN publish_failed_at END,
    publish_error = CASE WHEN COALESCE($7, post_status) = 'scheduled' THEN publish_error END,
    changed_at = now()
WHERE id = $10
RETURNING *;

-- name: UpdatePostSEO :one
-- PUT /posts/:id/seo (#357): the post's working SEO settings, replaced as a whole.
-- On a published post they reach the site on Update (golive_post_settings, 000031).
UPDATE posts
SET seo_title = sqlc.arg(seo_title),
    seo_description = sqlc.arg(seo_description),
    social_image_id = sqlc.narg(social_image_id),
    noindex = sqlc.arg(noindex),
    canonical_url = sqlc.arg(canonical_url),
    changed_at = now()
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: DeletePost :exec
DELETE FROM posts
WHERE id = $1;

-- name: DeleteUserPost :exec
DELETE FROM user_posts
WHERE post_id = $1;

-- name: CountTotalPosts :one
SELECT COUNT(*) AS total FROM posts;

-- name: CountPostsByType :one
SELECT COUNT(*) AS total FROM posts
WHERE post_type = $1;

-- name: ListPostsWithMeta :many
SELECT 
    p.id, p.title, p.description, p.user_id, p.username, p.url, 
    p.post_type, p.post_status, p.post_parent, p.menu_order, p.created_at, p.changed_at, p.published_block_doc, p.slug, p.published_settings,
    -- Changes not published (#326), for the admin only: the public lists share this
    -- query and pass false, so they don't pay for the settings comparison.
    (@with_unpublished_changes::boolean AND golive_post_has_unpublished_changes(p.id, p.post_status, p.block_doc_hash, p.published_block_hash, p.published_settings))::boolean AS has_unpublished_changes,
    -- A scheduled post's time, for the list's "Scheduled · Nov 3" pill (#147).
    p.publish_at,
    -- The Trash tab (#327): when, and the status a restore brings back. The
    -- public rows (authors.sql, terms_public.sql) select the same columns.
    p.deleted_at, p.trashed_from_status,
    -- Per-row subquery instead of LEFT JOIN + GROUP BY (#131): Postgres runs
    -- it after ORDER BY + LIMIT, so only the returned page reads post_meta.
    (
        SELECT COALESCE(jsonb_object_agg(pm.meta_key, pm.meta_value), '{}'::jsonb)
        FROM post_meta pm
        WHERE pm.post_id = p.id
    ) as meta,
    -- The byline (#340): every user_posts author in credit order, for the
    -- admin list's avatars. Public fields only (no email or role).
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
WHERE 
    (@post_type::text = '' OR p.post_type = @post_type)
    -- status: one status or a comma list; none = every status but the trash (#327).
    AND (CASE WHEN @post_status::text = '' THEN p.post_status <> 'trash'
              ELSE p.post_status = ANY(string_to_array(replace(@post_status::text, ' ', ''), ',')) END)
    -- Filters (#327): credited in the byline (user_posts), and linked to every term given.
    AND (@author_id::bigint = 0 OR EXISTS (SELECT 1 FROM user_posts fa WHERE fa.post_id = p.id AND fa.user_id = @author_id::bigint))
    AND NOT EXISTS (
        SELECT 1 FROM unnest(@term_ids::bigint[]) AS ft(id)
        WHERE NOT EXISTS (SELECT 1 FROM post_taxonomy_relationships fr WHERE fr.post_id = p.id AND fr.taxonomy_term_id = ft.id)
    )
    AND (@user_id::bigint = 0 OR p.user_id = @user_id)  -- Add user filter
    -- What the caller may read (#393): 0 = everything (moderators, /public); a
    -- contributor's id = their own posts plus published ones (canReadPost).
    AND (@viewer_id::bigint = 0 OR p.user_id = @viewer_id OR p.post_status = 'published')
    AND (NOT @unpublished_changes::boolean OR golive_post_has_unpublished_changes(p.id, p.post_status, p.block_doc_hash, p.published_block_hash, p.published_settings))
-- Whitelisted sort (#89): the API resolves sort_column/sort_direction to one
-- of these pairs; anything else falls through to the id tiebreaker.
-- changed_at sorts as GREATEST(changed_at, created_at): never-updated posts
-- keep the 0001-01-01 sentinel and rank by creation time instead.
ORDER BY
    CASE WHEN @sort_column::text = 'created_at' AND @sort_direction::text = 'asc' THEN p.created_at END ASC,
    CASE WHEN @sort_column::text = 'created_at' AND @sort_direction::text = 'desc' THEN p.created_at END DESC,
    CASE WHEN @sort_column::text = 'changed_at' AND @sort_direction::text = 'asc' THEN GREATEST(p.changed_at, p.created_at) END ASC,
    CASE WHEN @sort_column::text = 'changed_at' AND @sort_direction::text = 'desc' THEN GREATEST(p.changed_at, p.created_at) END DESC,
    CASE WHEN @sort_column::text = 'title' AND @sort_direction::text = 'asc' THEN p.title END ASC,
    CASE WHEN @sort_column::text = 'title' AND @sort_direction::text = 'desc' THEN p.title END DESC,
    CASE WHEN @sort_column::text = 'menu_order' AND @sort_direction::text = 'asc' THEN p.menu_order END ASC,
    CASE WHEN @sort_column::text = 'menu_order' AND @sort_direction::text = 'desc' THEN p.menu_order END DESC,
    -- Stable tiebreaker in the requested direction (also serves sort=id).
    CASE WHEN @sort_direction::text = 'asc' THEN p.id END ASC,
    p.id DESC
LIMIT @limit_count
OFFSET @offset_count;

-- name: CountFilteredPosts :one
SELECT COUNT(*) AS total FROM posts p
WHERE
    (@post_type::text = '' OR p.post_type = @post_type)
    -- status: one status or a comma list; none = every status but the trash (#327).
    AND (CASE WHEN @post_status::text = '' THEN p.post_status <> 'trash'
              ELSE p.post_status = ANY(string_to_array(replace(@post_status::text, ' ', ''), ',')) END)
    -- Filters (#327): credited in the byline (user_posts), and linked to every term given.
    AND (@author_id::bigint = 0 OR EXISTS (SELECT 1 FROM user_posts fa WHERE fa.post_id = p.id AND fa.user_id = @author_id::bigint))
    AND NOT EXISTS (
        SELECT 1 FROM unnest(@term_ids::bigint[]) AS ft(id)
        WHERE NOT EXISTS (SELECT 1 FROM post_taxonomy_relationships fr WHERE fr.post_id = p.id AND fr.taxonomy_term_id = ft.id)
    )
    AND (@user_id::bigint = 0 OR p.user_id = @user_id)
    -- What the caller may read (#393): 0 = everything (moderators, /public); a
    -- contributor's id = their own posts plus published ones (canReadPost).
    AND (@viewer_id::bigint = 0 OR p.user_id = @viewer_id OR p.post_status = 'published')
    AND (NOT @unpublished_changes::boolean
         OR golive_post_has_unpublished_changes(p.id, p.post_status, p.block_doc_hash, p.published_block_hash, p.published_settings));

-- name: CountPostsByStatus :many
-- The admin list's status tabs (#340): one count per status, with the list's
-- type and owner filters. unpublished_changes: how many of them have changes
-- not published (#326; only published posts can).
SELECT p.post_status, COUNT(*) AS total,
       COUNT(*) FILTER (
           WHERE golive_post_has_unpublished_changes(p.id, p.post_status, p.block_doc_hash, p.published_block_hash, p.published_settings)
       ) AS unpublished_changes
FROM posts p
WHERE
    (@post_type::text = '' OR p.post_type = @post_type)
    AND (@user_id::bigint = 0 OR p.user_id = @user_id)
    -- What the caller may read (#393): 0 = everything (moderators, /public); a
    -- contributor's id = their own posts plus published ones (canReadPost).
    AND (@viewer_id::bigint = 0 OR p.user_id = @viewer_id OR p.post_status = 'published')
GROUP BY p.post_status
ORDER BY p.post_status;

-- name: GetPostHasUnpublishedChanges :one
-- GET /posts/:id and /posts/slug/:slug (#326): ListPosts' has_unpublished_changes
-- for one post.
SELECT golive_post_has_unpublished_changes(p.id, p.post_status, p.block_doc_hash, p.published_block_hash, p.published_settings)::boolean AS has_unpublished_changes
FROM posts p
WHERE p.id = $1;

-- name: CountPostsByTypeFiltered :one
SELECT COUNT(*) AS total FROM posts p
WHERE p.post_type = @post_type
    -- status: one status or a comma list; none = every status but the trash (#327).
    AND (CASE WHEN @post_status::text = '' THEN p.post_status <> 'trash'
              ELSE p.post_status = ANY(string_to_array(replace(@post_status::text, ' ', ''), ',')) END)
    -- Filters (#327): credited in the byline (user_posts), and linked to every term given.
    AND (@author_id::bigint = 0 OR EXISTS (SELECT 1 FROM user_posts fa WHERE fa.post_id = p.id AND fa.user_id = @author_id::bigint))
    AND NOT EXISTS (
        SELECT 1 FROM unnest(@term_ids::bigint[]) AS ft(id)
        WHERE NOT EXISTS (SELECT 1 FROM post_taxonomy_relationships fr WHERE fr.post_id = p.id AND fr.taxonomy_term_id = ft.id)
    )
    AND (@viewer_id::bigint = 0 OR p.user_id = @viewer_id OR p.post_status = 'published')  -- #393, as in ListPosts
    AND (NOT @unpublished_changes::boolean OR golive_post_has_unpublished_changes(p.id, p.post_status, p.block_doc_hash, p.published_block_hash, p.published_settings));


-- name: ListPostsWithAllMeta :many
SELECT 
    p.id, p.title, p.description, p.user_id, p.username, p.url, 
    p.post_type, p.post_status, p.post_parent, p.menu_order, p.created_at, p.changed_at, p.published_block_doc, p.slug,
    golive_post_has_unpublished_changes(p.id, p.post_status, p.block_doc_hash, p.published_block_hash, p.published_settings)::boolean AS has_unpublished_changes,
    -- Post custom meta
    -- Per-row subquery instead of LEFT JOIN + GROUP BY (#131): Postgres runs
    -- it after ORDER BY + LIMIT, so only the returned page reads post_meta.
    (
        SELECT COALESCE(jsonb_object_agg(pm.meta_key, pm.meta_value), '{}'::jsonb)
        FROM post_meta pm
        WHERE pm.post_id = p.id
    ) as post_meta,
    -- Author information
    jsonb_build_object(
        'id', u.id,
        'username', u.username,
        'email', u.email,
        'full_name', u.full_name,
        'role', u.role,
        'created_at', u.created_at
    ) as author_meta,
    -- Post type information
    jsonb_build_object(
        'name', pt.name,
        'label', pt.label,
        'description', pt.description,
        'hierarchical', pt.hierarchical,
        'public', pt.public,
        'supports', pt.supports
    ) as post_type_meta
FROM posts p
LEFT JOIN users u ON p.user_id = u.id
LEFT JOIN post_types pt ON p.post_type = pt.name
WHERE 
    (@post_type::text = '' OR p.post_type = @post_type)
    -- status: one status or a comma list; none = every status but the trash (#327).
    AND (CASE WHEN @post_status::text = '' THEN p.post_status <> 'trash'
              ELSE p.post_status = ANY(string_to_array(replace(@post_status::text, ' ', ''), ',')) END)
    -- Filters (#327): credited in the byline (user_posts), and linked to every term given.
    AND (@author_id::bigint = 0 OR EXISTS (SELECT 1 FROM user_posts fa WHERE fa.post_id = p.id AND fa.user_id = @author_id::bigint))
    AND NOT EXISTS (
        SELECT 1 FROM unnest(@term_ids::bigint[]) AS ft(id)
        WHERE NOT EXISTS (SELECT 1 FROM post_taxonomy_relationships fr WHERE fr.post_id = p.id AND fr.taxonomy_term_id = ft.id)
    )
    AND (@user_id::bigint = 0 OR p.user_id = @user_id)  -- Add user filter
    -- What the caller may read (#393): 0 = everything (moderators, /public); a
    -- contributor's id = their own posts plus published ones (canReadPost).
    AND (@viewer_id::bigint = 0 OR p.user_id = @viewer_id OR p.post_status = 'published')
    AND (NOT @unpublished_changes::boolean OR golive_post_has_unpublished_changes(p.id, p.post_status, p.block_doc_hash, p.published_block_hash, p.published_settings))
-- Whitelisted sort (#89): the API resolves sort_column/sort_direction to one
-- of these pairs; anything else falls through to the id tiebreaker.
-- changed_at sorts as GREATEST(changed_at, created_at): never-updated posts
-- keep the 0001-01-01 sentinel and rank by creation time instead.
ORDER BY
    CASE WHEN @sort_column::text = 'created_at' AND @sort_direction::text = 'asc' THEN p.created_at END ASC,
    CASE WHEN @sort_column::text = 'created_at' AND @sort_direction::text = 'desc' THEN p.created_at END DESC,
    CASE WHEN @sort_column::text = 'changed_at' AND @sort_direction::text = 'asc' THEN GREATEST(p.changed_at, p.created_at) END ASC,
    CASE WHEN @sort_column::text = 'changed_at' AND @sort_direction::text = 'desc' THEN GREATEST(p.changed_at, p.created_at) END DESC,
    CASE WHEN @sort_column::text = 'title' AND @sort_direction::text = 'asc' THEN p.title END ASC,
    CASE WHEN @sort_column::text = 'title' AND @sort_direction::text = 'desc' THEN p.title END DESC,
    CASE WHEN @sort_column::text = 'menu_order' AND @sort_direction::text = 'asc' THEN p.menu_order END ASC,
    CASE WHEN @sort_column::text = 'menu_order' AND @sort_direction::text = 'desc' THEN p.menu_order END DESC,
    -- Stable tiebreaker in the requested direction (also serves sort=id).
    CASE WHEN @sort_direction::text = 'asc' THEN p.id END ASC,
    p.id DESC
LIMIT @limit_count
OFFSET @offset_count;
-- Duplicating a post (#354, DuplicatePostTx): the copy's relationship rows,
-- read from the source inside the same transaction as the insert.

-- name: CopyPostTaxonomyTerms :exec
INSERT INTO post_taxonomy_relationships (post_id, taxonomy_term_id)
SELECT @new_post_id::bigint, ptr.taxonomy_term_id
FROM post_taxonomy_relationships ptr
WHERE ptr.post_id = @source_post_id::bigint;

-- name: CopyPostFeaturedImage :exec
-- The featured image is the order-0 post_media link plus its _thumbnail_*
-- meta (setFeaturedImage). The content image links (order > 0) are synced
-- from the copy's block_doc instead (SyncPostContentMedia).
INSERT INTO post_media (post_id, media_id, "order")
SELECT @new_post_id::bigint, pm.media_id, 0
FROM post_media pm
WHERE pm.post_id = @source_post_id::bigint AND pm."order" = 0;

-- name: CopyPostFeaturedImageMeta :exec
INSERT INTO post_meta (post_id, meta_key, meta_value)
SELECT @new_post_id::bigint, m.meta_key, m.meta_value
FROM post_meta m
WHERE m.post_id = @source_post_id::bigint
  AND m.meta_key IN ('_thumbnail_id', '_thumbnail_url');
