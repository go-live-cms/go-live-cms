-- name: GetPostBlocks :one
SELECT block_doc AS content, block_revision AS revision
FROM posts
WHERE id = $1;

-- name: UpdatePostBlocksIfRevisionMatches :one
UPDATE posts
SET block_doc = $2,
    block_revision = block_revision + 1
WHERE id = $1
  AND block_revision = $3
RETURNING block_doc AS content, block_revision AS revision;

-- name: GetPublishedPostBlocks :one
SELECT published_block_doc AS content
FROM posts
WHERE id = $1;