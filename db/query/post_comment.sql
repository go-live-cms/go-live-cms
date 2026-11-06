-- Block comments (#192, 000048). Who may do what is the API's (auth_posts.go);
-- these only read and write.

-- name: ListPostCommentThreads :many
-- A post's threads, oldest first, with the starter's and resolver's current names
-- (NULL for a member removed since).
SELECT t.id, t.post_id, t.block_id, t.created_at, t.resolved_at,
    t.created_by, cu.username AS creator_username, cu.full_name AS creator_full_name, cu.avatar_url AS creator_avatar_url,
    t.resolved_by, ru.username AS resolver_username, ru.full_name AS resolver_full_name, ru.avatar_url AS resolver_avatar_url
FROM post_comment_threads t
LEFT JOIN users cu ON cu.id = t.created_by
LEFT JOIN users ru ON ru.id = t.resolved_by
WHERE t.post_id = $1
ORDER BY t.created_at, t.id;

-- name: ListPostComments :many
-- Every comment of a post's threads (deleted ones too, without a body), in thread
-- order, with the author's current name.
SELECT c.id, c.thread_id, c.body, c.created_at, c.edited_at, c.deleted_at,
    c.author_id, au.username AS author_username, au.full_name AS author_full_name, au.avatar_url AS author_avatar_url
FROM post_comments c
JOIN post_comment_threads t ON t.id = c.thread_id
LEFT JOIN users au ON au.id = c.author_id
WHERE t.post_id = $1
ORDER BY c.thread_id, c.created_at, c.id;

-- name: CreatePostCommentThread :one
INSERT INTO post_comment_threads (post_id, block_id, created_by)
VALUES (sqlc.arg(post_id), sqlc.arg(block_id), sqlc.arg(created_by))
RETURNING *;

-- name: CreatePostComment :one
INSERT INTO post_comments (thread_id, author_id, body)
VALUES (sqlc.arg(thread_id), sqlc.arg(author_id), sqlc.arg(body))
RETURNING *;

-- name: GetPostCommentThread :one
SELECT * FROM post_comment_threads WHERE id = $1;

-- name: LockPostCommentThread :one
-- The thread row FOR UPDATE: deleting its comments serializes on it.
SELECT * FROM post_comment_threads WHERE id = $1 FOR UPDATE;

-- name: GetPostComment :one
-- One comment with its thread's post (the handlers check both).
SELECT c.*, t.post_id
FROM post_comments c
JOIN post_comment_threads t ON t.id = c.thread_id
WHERE c.id = $1;

-- name: UpdatePostCommentBody :one
-- An edit by the author. sql.ErrNoRows when it was deleted meanwhile.
UPDATE post_comments
SET body = sqlc.arg(body), edited_at = now()
WHERE id = sqlc.arg(id) AND deleted_at IS NULL
RETURNING *;

-- name: SoftDeletePostComment :one
-- Keeps the row so replies keep their place; the body goes.
UPDATE post_comments
SET body = '', deleted_at = now()
WHERE id = $1 AND deleted_at IS NULL
RETURNING *;

-- name: CountLivePostComments :one
SELECT count(*) FROM post_comments WHERE thread_id = $1 AND deleted_at IS NULL;

-- name: DeletePostCommentThread :exec
DELETE FROM post_comment_threads WHERE id = $1;

-- name: ResolvePostCommentThread :one
-- Idempotent: a thread resolved already keeps its resolver and time.
UPDATE post_comment_threads
SET resolved_at = COALESCE(resolved_at, now()),
    resolved_by = CASE WHEN resolved_at IS NULL THEN sqlc.narg(resolved_by) ELSE resolved_by END
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: UnresolvePostCommentThread :one
UPDATE post_comment_threads
SET resolved_at = NULL, resolved_by = NULL
WHERE id = $1
RETURNING *;
