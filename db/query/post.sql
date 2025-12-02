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
    menu_order
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9
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

-- name: CheckURLExists :one
SELECT EXISTS(SELECT 1 FROM posts WHERE url = $1) as exists;

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
SELECT id, title, description, user_id, username, url, post_type, post_status, post_parent, menu_order, created_at, changed_at, published_block_doc FROM posts
WHERE 
    (@post_type::text = '' OR post_type = @post_type)
    AND (@post_status::text = '' OR post_status = @post_status)
    AND (@user_id = 0 OR user_id = @user_id)  -- Add user filter
ORDER BY
    CASE WHEN @sort_by = 'date_asc' THEN created_at END ASC,
    CASE WHEN @sort_by = 'date_desc' THEN created_at END DESC,
    CASE WHEN @sort_by = 'title_asc' THEN title END ASC,
    CASE WHEN @sort_by = 'title_desc' THEN title END DESC,
    CASE WHEN @sort_by = 'menu_order_asc' THEN menu_order END ASC,
    CASE WHEN @sort_by = 'menu_order_desc' THEN menu_order END DESC,
    CASE WHEN @sort_by = 'id_asc' THEN id END ASC,
    CASE WHEN @sort_by = 'id_desc' THEN id END DESC,
    id DESC
LIMIT @limit_count
OFFSET @offset_count;

-- name: ListPostsByType :many
SELECT * FROM posts
WHERE post_type = @post_type
    AND (@post_status::text = '' OR post_status = @post_status)
    AND (@user_id = 0 OR user_id = @user_id)  -- Add user filter
ORDER BY
    CASE WHEN @sort_by = 'date_asc' THEN created_at END ASC,
    CASE WHEN @sort_by = 'date_desc' THEN created_at END DESC,
    CASE WHEN @sort_by = 'title_asc' THEN title END ASC,
    CASE WHEN @sort_by = 'title_desc' THEN title END DESC,
    CASE WHEN @sort_by = 'menu_order_asc' THEN menu_order END ASC,
    CASE WHEN @sort_by = 'menu_order_desc' THEN menu_order END DESC,
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
    p.post_type, p.post_status, p.post_parent, p.menu_order, p.created_at, p.changed_at, p.published_block_doc,
    COALESCE(
        jsonb_object_agg(
            pm.meta_key, 
            pm.meta_value
        ) FILTER (WHERE pm.meta_key IS NOT NULL),
        '{}'::jsonb
    ) as meta
FROM posts p
LEFT JOIN post_meta pm ON p.id = pm.post_id
WHERE 
    (@post_type::text = '' OR p.post_type = @post_type)
    AND (@post_status::text = '' OR p.post_status = @post_status)
    AND (@user_id = 0 OR p.user_id = @user_id)  -- Add user filter
GROUP BY p.id, p.title, p.description, p.published_block_doc, p.user_id, p.username, p.url, p.post_type, p.post_status, p.post_parent, p.menu_order, p.created_at, p.changed_at
ORDER BY
    CASE WHEN @sort_by = 'date_asc' THEN p.created_at END ASC,
    CASE WHEN @sort_by = 'date_desc' THEN p.created_at END DESC,
    CASE WHEN @sort_by = 'title_asc' THEN p.title END ASC,
    CASE WHEN @sort_by = 'title_desc' THEN p.title END DESC,
    CASE WHEN @sort_by = 'menu_order_asc' THEN p.menu_order END ASC,
    CASE WHEN @sort_by = 'menu_order_desc' THEN p.menu_order END DESC,
    CASE WHEN @sort_by = 'id_asc' THEN p.id END ASC,
    CASE WHEN @sort_by = 'id_desc' THEN p.id END DESC,
    p.id DESC
LIMIT @limit_count
OFFSET @offset_count;

-- name: ListPostsByTypeWithMeta :many
SELECT 
    p.id, p.title, p.description, p.user_id, p.username, p.url, 
    p.post_type, p.post_status, p.post_parent, p.menu_order, p.created_at, p.changed_at, p.published_block_doc,
    COALESCE(
        jsonb_object_agg(
            pm.meta_key, 
            pm.meta_value
        ) FILTER (WHERE pm.meta_key IS NOT NULL),
        '{}'::jsonb
    ) as meta
FROM posts p
LEFT JOIN post_meta pm ON p.id = pm.post_id
WHERE p.post_type = @post_type
    AND (@post_status::text = '' OR p.post_status = @post_status)
    AND (@user_id = 0 OR p.user_id = @user_id)  -- Add user filter
GROUP BY p.id, p.title, p.description, p.published_block_doc, p.user_id, p.username, p.url, p.post_type, p.post_status, p.post_parent, p.menu_order, p.created_at, p.changed_at
ORDER BY
    CASE WHEN @sort_by = 'date_asc' THEN p.created_at END ASC,
    CASE WHEN @sort_by = 'date_desc' THEN p.created_at END DESC,
    CASE WHEN @sort_by = 'title_asc' THEN p.title END ASC,
    CASE WHEN @sort_by = 'title_desc' THEN p.title END DESC,
    CASE WHEN @sort_by = 'menu_order_asc' THEN p.menu_order END ASC,
    CASE WHEN @sort_by = 'menu_order_desc' THEN p.menu_order END DESC,
    p.id DESC
LIMIT @limit_count
OFFSET @offset_count;

-- name: CountFilteredPosts :one
SELECT COUNT(*) AS total FROM posts
WHERE 
    (@post_type::text = '' OR post_type = @post_type)
    AND (@post_status::text = '' OR post_status = @post_status)
    AND (@user_id = 0 OR user_id = @user_id);

-- name: CountPostsByTypeFiltered :one
SELECT COUNT(*) AS total FROM posts
WHERE post_type = @post_type
    AND (@post_status::text = '' OR post_status = @post_status);


-- name: ListPostsWithAllMeta :many
SELECT 
    p.id, p.title, p.description, p.user_id, p.username, p.url, 
    p.post_type, p.post_status, p.post_parent, p.menu_order, p.created_at, p.changed_at, p.published_block_doc,
    -- Post custom meta
    COALESCE(
        jsonb_object_agg(
            pm.meta_key, 
            pm.meta_value
        ) FILTER (WHERE pm.meta_key IS NOT NULL),
        '{}'::jsonb
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
LEFT JOIN post_meta pm ON p.id = pm.post_id
LEFT JOIN users u ON p.user_id = u.id
LEFT JOIN post_types pt ON p.post_type = pt.name
WHERE 
    (@post_type::text = '' OR p.post_type = @post_type)
    AND (@post_status::text = '' OR p.post_status = @post_status)
    AND (@user_id = 0 OR p.user_id = @user_id)  -- Add user filter
GROUP BY p.id, p.title, p.description, p.published_block_doc, p.user_id, p.username, p.url, 
         p.post_type, p.post_status, p.post_parent, p.menu_order, p.created_at, p.changed_at,
         u.id, u.username, u.email, u.full_name, u.role, u.created_at,
         pt.name, pt.label, pt.description, pt.hierarchical, pt.public, pt.supports
ORDER BY
    CASE WHEN @sort_by = 'date_asc' THEN p.created_at END ASC,
    CASE WHEN @sort_by = 'date_desc' THEN p.created_at END DESC,
    CASE WHEN @sort_by = 'title_asc' THEN p.title END ASC,
    CASE WHEN @sort_by = 'title_desc' THEN p.title END DESC,
    CASE WHEN @sort_by = 'menu_order_asc' THEN p.menu_order END ASC,
    CASE WHEN @sort_by = 'menu_order_desc' THEN p.menu_order END DESC,
    CASE WHEN @sort_by = 'id_asc' THEN p.id END ASC,
    CASE WHEN @sort_by = 'id_desc' THEN p.id END DESC,
    p.id DESC
LIMIT @limit_count
OFFSET @offset_count;

-- name: ListPostsByTypeWithAllMeta :many
SELECT 
    p.id, p.title, p.description, p.user_id, p.username, p.url, 
    p.post_type, p.post_status, p.post_parent, p.menu_order, p.created_at, p.changed_at, p.published_block_doc,
    -- Post custom meta
    COALESCE(
        jsonb_object_agg(
            pm.meta_key, 
            pm.meta_value
        ) FILTER (WHERE pm.meta_key IS NOT NULL),
        '{}'::jsonb
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
LEFT JOIN post_meta pm ON p.id = pm.post_id
LEFT JOIN users u ON p.user_id = u.id
LEFT JOIN post_types pt ON p.post_type = pt.name
WHERE p.post_type = @post_type
    AND (@post_status::text = '' OR p.post_status = @post_status)
    AND (@user_id = 0 OR p.user_id = @user_id)  -- Add user filter
GROUP BY p.id, p.title, p.description, p.published_block_doc, p.user_id, p.username, p.url, 
         p.post_type, p.post_status, p.post_parent, p.menu_order, p.created_at, p.changed_at,
         u.id, u.username, u.email, u.full_name, u.role, u.created_at,
         pt.name, pt.label, pt.description, pt.hierarchical, pt.public, pt.supports
ORDER BY
    CASE WHEN @sort_by = 'date_asc' THEN p.created_at END ASC,
    CASE WHEN @sort_by = 'date_desc' THEN p.created_at END DESC,
    CASE WHEN @sort_by = 'title_asc' THEN p.title END ASC,
    CASE WHEN @sort_by = 'title_desc' THEN p.title END DESC,
    CASE WHEN @sort_by = 'menu_order_asc' THEN p.menu_order END ASC,
    CASE WHEN @sort_by = 'menu_order_desc' THEN p.menu_order END DESC,
    p.id DESC
LIMIT @limit_count
OFFSET @offset_count;