-- name: GetNextVersionNoForPost :one
SELECT COALESCE(MAX(version_no), 0) + 1 AS next_no
FROM post_versions
WHERE post_id = $1;

-- name: InsertPostVersion :one
INSERT INTO post_versions (post_id, version_no, status, label, message, block_doc, created_by)
VALUES ($1, $2, 'published', $3, $4, $5, $6)
RETURNING id, version_no;

-- name: SetPublishedVersionOnPost :exec
UPDATE posts
SET published_version_id = $2,
    published_block_doc = $3
WHERE id = $1;

-- name: GetPostVersions :many
SELECT id, version_no, status, label, message, created_at, created_by
FROM post_versions
WHERE post_id = $1
ORDER BY version_no DESC;

-- name: GetLatestPublishedVersion :one
SELECT id, version_no, status, label, message, block_doc, created_at, created_by
FROM post_versions
WHERE post_id = $1
  AND status = 'published'
ORDER BY version_no DESC
LIMIT 1;