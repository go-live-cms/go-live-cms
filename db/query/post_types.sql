-- name: CreatePostType :one
INSERT INTO post_types (
    name,
    label,
    description,
    public,
    hierarchical,
    has_archive,
    menu_position,
    supports
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8
) RETURNING *;

-- name: GetPostType :one
SELECT * FROM post_types 
WHERE name = $1 LIMIT 1;

-- name: GetPostTypeByID :one
SELECT * FROM post_types 
WHERE id = $1 LIMIT 1;

-- name: ListPostTypes :many
SELECT * FROM post_types
ORDER BY menu_position ASC, name ASC;

-- name: UpdatePostType :one
UPDATE post_types
SET label = COALESCE($1, label),
    description = COALESCE($2, description),
    public = COALESCE($3, public),
    hierarchical = COALESCE($4, hierarchical),
    has_archive = COALESCE($5, has_archive),
    menu_position = COALESCE($6, menu_position),
    supports = COALESCE($7, supports)
WHERE name = $8
RETURNING *;

-- name: DeletePostType :exec
DELETE FROM post_types
WHERE name = $1;

-- name: CreatePostMeta :one
INSERT INTO post_meta (
    post_id,
    meta_key,
    meta_value
) VALUES (
    $1, $2, $3
) RETURNING *;

-- name: GetPostMeta :many
SELECT * FROM post_meta
WHERE post_id = $1
ORDER BY meta_key ASC;

-- name: GetPostMetaByKey :one
SELECT * FROM post_meta
WHERE post_id = $1 AND meta_key = $2 LIMIT 1;

-- name: UpdatePostMeta :one
UPDATE post_meta
SET meta_value = $3
WHERE post_id = $1 AND meta_key = $2
RETURNING *;

-- name: DeletePostMeta :exec
DELETE FROM post_meta
WHERE post_id = $1 AND meta_key = $2;

-- name: DeleteAllPostMeta :exec
DELETE FROM post_meta
WHERE post_id = $1;

-- name: UpsertPostMeta :one
INSERT INTO post_meta (post_id, meta_key, meta_value)
VALUES ($1, $2, $3)
ON CONFLICT (post_id, meta_key) 
DO UPDATE SET meta_value = EXCLUDED.meta_value
RETURNING *;