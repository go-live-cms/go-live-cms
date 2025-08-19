-- name: CreatePosts :one
INSERT INTO posts (
    title,
    description,
    user_id,
    username,
    content,
    url
) VALUES (
    $1, $2, $3, $4, $5, $6
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

-- name: ListPosts :many
SELECT * FROM posts
ORDER BY
    CASE WHEN @sort_by = 'date_asc' THEN created_at END ASC,
    CASE WHEN @sort_by = 'date_desc' THEN created_at END DESC,
    CASE WHEN @sort_by = 'title_asc' THEN title END ASC,
    CASE WHEN @sort_by = 'title_desc' THEN title END DESC,
    CASE WHEN @sort_by = 'id_asc' THEN id END ASC,
    CASE WHEN @sort_by = 'id_desc' THEN id END DESC,
    id DESC
LIMIT @limit_count
OFFSET @offset_count;

-- name: UpdatePost :one
UPDATE posts
SET title = COALESCE($1, title),
    description = COALESCE($2, description),
    user_id = COALESCE($3, user_id),
    username = COALESCE($4, username),
    content = COALESCE($5, content),
    url = COALESCE($6, url),
    changed_at = now()
WHERE id = $7
RETURNING *;

-- name: DeletePost :exec
DELETE FROM posts
WHERE id = $1;

-- name: DeleteUserPost :exec
DELETE FROM user_posts
WHERE post_id = $1;

-- name: CountTotalPosts :one
SELECT COUNT(*) AS total FROM posts;
