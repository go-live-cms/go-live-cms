-- name: GetPostBlocks :one
SELECT block_doc AS content, block_revision AS revision
FROM posts
WHERE id = $1;

-- name: UpdatePostBlocksIfRevisionMatches :one
-- Sets changed_at itself, like UpdatePostBlockDocFromCollab: the title update
-- the handler may run afterwards is skipped without a title, or for a
-- contributor's published post (#307).
UPDATE posts
SET block_doc = $2,
    block_revision = block_revision + 1,
    changed_at = now()
WHERE id = $1
  AND block_revision = $3
RETURNING block_doc AS content, block_revision AS revision;

-- name: GetPublishedPostBlocks :one
SELECT published_block_doc AS content, post_status
FROM posts
WHERE id = $1;