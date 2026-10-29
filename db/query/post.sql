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
SELECT id, title, description, user_id, username, url, post_type, post_status, post_parent, menu_order, created_at, changed_at, published_block_doc, slug FROM posts
WHERE 
    (@post_type::text = '' OR post_type = @post_type)
    AND (@post_status::text = '' OR post_status = ANY(string_to_array(replace(@post_status::text, ' ', ''), ',')))
    AND (@user_id = 0 OR user_id = @user_id)  -- Add user filter
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
    post_status = COALESCE($7, post_status),
    post_parent = COALESCE($8, post_parent),
    menu_order = COALESCE($9, menu_order),
    changed_at = now()
WHERE id = $10
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
    p.post_type, p.post_status, p.post_parent, p.menu_order, p.created_at, p.changed_at, p.published_block_doc, p.slug,
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
    AND (@post_status::text = '' OR p.post_status = ANY(string_to_array(replace(@post_status::text, ' ', ''), ',')))
    AND (@user_id = 0 OR p.user_id = @user_id)  -- Add user filter
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
SELECT COUNT(*) AS total FROM posts
WHERE 
    (@post_type::text = '' OR post_type = @post_type)
    AND (@post_status::text = '' OR post_status = ANY(string_to_array(replace(@post_status::text, ' ', ''), ',')))
    AND (@user_id = 0 OR user_id = @user_id);

-- name: CountPostsByStatus :many
-- The admin list's status tabs (#340): one count per status, with the list's
-- type and owner filters.
SELECT post_status, COUNT(*) AS total FROM posts
WHERE
    (@post_type::text = '' OR post_type = @post_type)
    AND (@user_id::bigint = 0 OR user_id = @user_id)
GROUP BY post_status
ORDER BY post_status;

-- name: CountPostsByTypeFiltered :one
SELECT COUNT(*) AS total FROM posts
WHERE post_type = @post_type
    AND (@post_status::text = '' OR post_status = ANY(string_to_array(replace(@post_status::text, ' ', ''), ',')));


-- name: ListPostsWithAllMeta :many
SELECT 
    p.id, p.title, p.description, p.user_id, p.username, p.url, 
    p.post_type, p.post_status, p.post_parent, p.menu_order, p.created_at, p.changed_at, p.published_block_doc, p.slug,
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
    AND (@post_status::text = '' OR p.post_status = ANY(string_to_array(replace(@post_status::text, ' ', ''), ',')))
    AND (@user_id = 0 OR p.user_id = @user_id)  -- Add user filter
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