-- name: CreateMedia :one
INSERT INTO media (
    name,
    description,
    alt,
    media_path,
    user_id,
    file_size,
    mime_type,
    width,
    height,
    duration,
    original_filename
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
) RETURNING *;

-- name: GetMedia :one
SELECT * FROM media
WHERE id = $1 LIMIT 1;

-- name: GetMediaByUser :many
SELECT 
    m.*,
    COUNT(pm.post_id) as post_count
FROM media m
LEFT JOIN post_media pm ON m.id = pm.media_id
WHERE m.user_id = $1
GROUP BY m.id, m.name, m.description, m.alt, m.media_path, m.user_id, m.created_at, m.changed_at, m.file_size, m.mime_type, m.width, m.height, m.duration, m.original_filename, m.metadata
ORDER BY m.created_at DESC
LIMIT $2
OFFSET $3;

-- name: ListMedia :many
SELECT 
    m.*,
    COUNT(pm.post_id) as post_count
FROM media m
LEFT JOIN post_media pm ON m.id = pm.media_id
GROUP BY m.id, m.name, m.description, m.alt, m.media_path, m.user_id, m.created_at, m.changed_at, m.file_size, m.mime_type, m.width, m.height, m.duration, m.original_filename, m.metadata
ORDER BY m.created_at DESC
LIMIT $1
OFFSET $2;

-- name: UpdateMedia :one
UPDATE media
SET
    name = COALESCE($2, name),
    description = COALESCE($3, description),
    alt = COALESCE($4, alt),
    media_path = COALESCE($5, media_path),
    file_size = COALESCE($6, file_size),
    mime_type = COALESCE($7, mime_type),
    width = COALESCE($8, width),
    height = COALESCE($9, height),
    duration = COALESCE($10, duration),
    original_filename = COALESCE($11, original_filename),
    changed_at = now()
WHERE id = $1
RETURNING *;

-- name: DeleteMedia :exec
DELETE FROM media
WHERE id = $1;

-- name: DeleteMediaByUserID :exec
DELETE FROM media
WHERE user_id = $1;

-- name: SearchMediaByName :many
SELECT 
    m.*,
    COUNT(pm.post_id) as post_count
FROM media m
LEFT JOIN post_media pm ON m.id = pm.media_id
WHERE m.name ILIKE '%' || $1 || '%' OR m.description ILIKE '%' || $1 || '%'
GROUP BY m.id, m.name, m.description, m.alt, m.media_path, m.user_id, m.created_at, m.changed_at, m.file_size, m.mime_type, m.width, m.height, m.duration, m.original_filename, m.metadata
ORDER BY m.created_at DESC
LIMIT $2
OFFSET $3;

-- name: GetMediaByPost :many
SELECT m.* FROM media m
JOIN post_media pm ON m.id = pm.media_id
WHERE pm.post_id = $1
ORDER BY pm."order", m.created_at;

-- name: CreatePostMedia :one
INSERT INTO post_media (
    post_id,
    media_id,
    "order"
) VALUES (
    $1, $2, $3
) RETURNING *;

-- name: DeletePostMedia :exec
DELETE FROM post_media
WHERE post_id = $1 AND media_id = $2;

-- name: DeletePostMedias :exec
DELETE FROM post_media
WHERE post_id = $1;

-- name: DeleteMediaPosts :exec
DELETE FROM post_media
WHERE media_id = $1;

-- name: GetMediaPostCount :one
SELECT COUNT(*) FROM post_media
WHERE media_id = $1;

-- name: GetPostMediaCount :one
SELECT COUNT(*) FROM post_media
WHERE post_id = $1;

-- name: GetPopularMedia :many
SELECT 
    m.*,
    COUNT(pm.post_id) as post_count
FROM media m
JOIN post_media pm ON m.id = pm.media_id
GROUP BY m.id, m.name, m.description, m.alt, m.media_path, m.user_id, m.created_at, m.changed_at, m.file_size, m.mime_type, m.width, m.height, m.duration, m.original_filename, m.metadata
HAVING COUNT(pm.post_id) > 0
ORDER BY COUNT(pm.post_id) DESC
LIMIT $1;

-- name: GetUserMediaCount :one
SELECT COUNT(*) FROM media
WHERE user_id = $1;

-- name: TransferMediaToUser :exec
UPDATE media
SET user_id = $2
WHERE user_id = $1;

-- name: GetPostWithMedia :one
SELECT 
    p.*,
    COALESCE(
        json_agg(
            json_build_object(
                'id', m.id,
                'name', m.name,
                'description', m.description,
                'alt', m.alt,
                'media_path', m.media_path,
                'user_id', m.user_id,
                'created_at', m.created_at,
                'changed_at', m.changed_at,
                'order', pm."order"
            ) ORDER BY pm."order", m.created_at
        ) FILTER (WHERE m.id IS NOT NULL),
        '[]'::json
    ) as media
FROM posts p
LEFT JOIN post_media pm ON p.id = pm.post_id
LEFT JOIN media m ON pm.media_id = m.id
WHERE p.id = $1
GROUP BY p.id, p.title, p.description, p.content, p.user_id, p.username, p.url, p.created_at, p.changed_at;

-- name: ListPostsWithMedia :many
SELECT 
    p.*,
    COALESCE(
        json_agg(
            json_build_object(
                'id', m.id,
                'name', m.name,
                'description', m.description,
                'alt', m.alt,
                'media_path', m.media_path,
                'user_id', m.user_id,
                'created_at', m.created_at,
                'changed_at', m.changed_at,
                'order', pm."order"
            ) ORDER BY pm."order", m.created_at
        ) FILTER (WHERE m.id IS NOT NULL),
        '[]'::json
    ) as media
FROM posts p
LEFT JOIN post_media pm ON p.id = pm.post_id
LEFT JOIN media m ON pm.media_id = m.id
GROUP BY p.id, p.title, p.description, p.content, p.user_id, p.username, p.url, p.created_at, p.changed_at
ORDER BY p.created_at DESC
LIMIT $1
OFFSET $2;

-- name: GetPostsByUserWithMedia :many
SELECT 
    p.*,
    COALESCE(
        json_agg(
            json_build_object(
                'id', m.id,
                'name', m.name,
                'description', m.description,
                'alt', m.alt,
                'media_path', m.media_path,
                'user_id', m.user_id,
                'created_at', m.created_at,
                'changed_at', m.changed_at,
                'order', pm."order"
            ) ORDER BY pm."order", m.created_at
        ) FILTER (WHERE m.id IS NOT NULL),
        '[]'::json
    ) as media
FROM posts p
LEFT JOIN post_media pm ON p.id = pm.post_id
LEFT JOIN media m ON pm.media_id = m.id
WHERE p.user_id = $1
GROUP BY p.id, p.title, p.description, p.content, p.user_id, p.username, p.url, p.created_at, p.changed_at
ORDER BY p.created_at DESC
LIMIT $2
OFFSET $3;

-- name: CountTotalMedia :one
SELECT COUNT(*) AS total FROM media;