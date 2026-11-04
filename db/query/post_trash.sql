-- Trash (#327, 000036). DELETE /posts/:id moves a post here; restore brings back
-- the status it had; permanent delete (DeleteTrashedPostTx) removes the row. The
-- API decides who may do which (auth_posts.go); these only change the state.

-- name: TrashPost :one
-- Moves a post to the trash. No row: missing or already there. A scheduled post
-- keeps its time and who scheduled it (000036's CHECK allows that), but its claim
-- and retry state are cleared: a scheduler attempt already in flight is fenced off
-- (LockScheduledPostClaim wants post_status 'scheduled' anyway). changed_at stays:
-- trashing isn't an edit.
UPDATE posts
SET trashed_from_status = post_status,
    post_status = 'trash',
    deleted_at = now(),
    publish_attempts = 0,
    publish_next_attempt_at = NULL,
    publish_failed_at = NULL,
    publish_error = NULL
WHERE id = $1
  AND post_status <> 'trash'
RETURNING *;

-- name: RestorePostFromTrash :one
-- Takes a post out of the trash with the status it had. A scheduled post whose
-- time is still ahead is scheduled again (a fresh start: no attempts); one whose
-- time has passed comes back as a draft, so restoring never publishes at once. A
-- published post's snapshot was kept, so it is live again as it was. No row:
-- missing or not in the trash.
UPDATE posts
SET post_status = CASE
        WHEN trashed_from_status = 'scheduled' AND (publish_at IS NULL OR publish_at <= now()) THEN 'draft'
        ELSE trashed_from_status
    END,
    publish_at = CASE WHEN trashed_from_status = 'scheduled' AND publish_at > now() THEN publish_at END,
    publish_scheduled_by = CASE WHEN trashed_from_status = 'scheduled' AND publish_at > now() THEN publish_scheduled_by END,
    publish_attempts = 0,
    publish_next_attempt_at = NULL,
    publish_failed_at = NULL,
    publish_error = NULL,
    trashed_from_status = NULL,
    deleted_at = NULL
WHERE id = $1
  AND post_status = 'trash'
RETURNING *;

-- name: LockPostStatus :one
-- DeleteTrashedPostTx: the post's status under a row lock.
SELECT post_status FROM posts WHERE id = $1 FOR UPDATE;

-- name: ListCreditedAuthors :many
-- The posts list's Author filter (#327): everyone credited (user_posts) on a post of
-- this type that the caller may read (viewer_id as in ListPosts, #393), trash aside.
-- Public fields only. Kept short: a filter menu, not a member directory.
SELECT DISTINCT u.id, u.username, u.full_name
FROM users u
JOIN user_posts up ON up.user_id = u.id
JOIN posts p ON p.id = up.post_id
WHERE (@post_type::text = '' OR p.post_type = @post_type::text)
  AND p.post_status <> 'trash'
  AND (@viewer_id::bigint = 0 OR p.user_id = @viewer_id::bigint OR p.post_status = 'published')
ORDER BY u.full_name, u.username, u.id
LIMIT 200;
