-- name: CreatePosts :one
INSERT INTO posts (
    title,
    description,
    user_id,
    username,
    content,
    url,
    post_type,
    post_status,
    post_parent,
    menu_order
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
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
GROUP BY p.id, p.title, p.description, p.content, p.user_id, p.username, p.url, p.post_type, p.post_status, p.post_parent, p.menu_order, p.created_at, p.changed_at;

-- name: ListPosts :many
SELECT * FROM posts
WHERE 
    ($1 = '' OR post_type = $1)
    AND ($2 = '' OR post_status = $2)
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
WHERE post_type = $1
    AND ($2 = '' OR post_status = $2)
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
    content = COALESCE($5, content),
    url = COALESCE($6, url),
    post_type = COALESCE($7, post_type),
    post_status = COALESCE($8, post_status),
    post_parent = COALESCE($9, post_parent),
    menu_order = COALESCE($10, menu_order),
    changed_at = now()
WHERE id = $11
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