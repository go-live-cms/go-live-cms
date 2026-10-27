-- name: GetPostBlocks :one
SELECT block_doc AS content, block_revision AS revision
FROM posts
WHERE id = $1;

-- name: GetPublishedPostBlocks :one
SELECT published_block_doc AS content, post_status
FROM posts
WHERE id = $1;