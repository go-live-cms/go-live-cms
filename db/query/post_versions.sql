-- name: GetNextVersionNoForPost :one
SELECT COALESCE(MAX(version_no), 0) + 1 AS next_no
FROM post_versions
WHERE post_id = $1;

-- name: InsertPostVersion :one
INSERT INTO post_versions (post_id, version_no, status, label, message, block_doc, created_by)
VALUES ($1, $2, 'published', $3, $4, $5, $6)
RETURNING id, version_no;

-- name: SetPublishedVersionOnPost :exec
-- Publishing also makes the post public: post_status follows the snapshot, so a
-- post published from the editor is not left as 'draft' in the database.
UPDATE posts
SET published_version_id = $2,
    published_block_doc = $3,
    post_status = 'published'
WHERE id = $1;

-- name: UnpublishPost :one
-- Back to draft and drop the public snapshot (#136). The snapshot stays in
-- post_versions, so it can still be viewed and restored.
UPDATE posts
SET post_status = 'draft',
    published_version_id = NULL,
    published_block_doc = NULL
WHERE id = $1
RETURNING *;

-- name: GetPostVersions :many
SELECT v.id, v.version_no, v.status, v.label, v.message, v.created_at, v.created_by,
       u.username AS created_by_username
FROM post_versions v
LEFT JOIN users u ON u.id = v.created_by
WHERE v.post_id = $1
ORDER BY v.version_no DESC;

-- name: GetPostVersion :one
SELECT v.id, v.version_no, v.status, v.label, v.message, v.block_doc, v.created_at, v.created_by,
       u.username AS created_by_username
FROM post_versions v
LEFT JOIN users u ON u.id = v.created_by
WHERE v.post_id = $1
  AND v.version_no = $2;

-- name: GetLatestPublishedVersion :one
SELECT id, version_no, status, label, message, block_doc, created_at, created_by
FROM post_versions
WHERE post_id = $1
  AND status = 'published'
ORDER BY version_no DESC
LIMIT 1;
