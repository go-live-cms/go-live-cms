-- Activity log (#324, 000036). Written by the API's write paths (api/activity.go)
-- and the collab store (StorePostCollabTx); read by GET /activity and Home.

-- name: CreateActivity :one
-- An actor that no longer exists is stored as NULL rather than failing on the
-- foreign key (a member removed while their request was in flight).
INSERT INTO activity (actor_id, verb, object_type, object_id, payload)
VALUES (
    (SELECT u.id FROM users u WHERE u.id = sqlc.narg(actor_id)::bigint),
    @verb, @object_type, @object_id, @payload
)
RETURNING *;

-- name: CreateActivityThrottled :execrows
-- High-volume events ("edited", "updated"): at most one per actor, verb and object
-- per window. 0 rows = one was recorded within the window (or the actor is gone).
-- The collab store runs it under the post's row lock, so concurrent stores of one
-- post can't both insert; elsewhere a race costs at most a duplicate.
INSERT INTO activity (actor_id, verb, object_type, object_id, payload)
SELECT u.id, @verb, @object_type, @object_id, @payload
FROM users u
WHERE u.id = @actor_id
  AND NOT EXISTS (
    SELECT 1 FROM activity a
    WHERE a.object_type = @object_type
      AND a.object_id = @object_id
      AND a.actor_id = @actor_id
      AND a.verb = @verb
      AND a.created_at > now() - make_interval(secs => @window_seconds::float8)
  );

-- name: ListActivity :many
-- Newest first, paged by id (before_id: the last id of the previous page). What a
-- viewer sees (the API passes its role):
--   - admins: everything;
--   - moderators (editors): every post and media event;
--   - everyone else: events on posts they own or that are published (canReadPost,
--     judged on the post as it is now, so a deleted post's events are hidden), and
--     on media they uploaded.
-- Member, invitation and settings events are admin-only. Names and titles are
-- joined now, never stored. object_type/object_id narrow it to one object.
SELECT
    a.id, a.actor_id, a.verb, a.object_type, a.object_id, a.payload, a.created_at,
    actor.username AS actor_username,
    actor.full_name AS actor_full_name,
    p.title AS post_title,
    p.post_type AS post_type,
    p.post_status AS post_status,
    m.name AS media_name,
    target.username AS target_username,
    target.full_name AS target_full_name
FROM activity a
LEFT JOIN users actor ON actor.id = a.actor_id
LEFT JOIN posts p ON a.object_type = 'post' AND p.id = a.object_id
LEFT JOIN media m ON a.object_type = 'media' AND m.id = a.object_id
LEFT JOIN users target ON a.object_type = 'user' AND target.id = a.object_id
WHERE (sqlc.narg(before_id)::bigint IS NULL OR a.id < sqlc.narg(before_id)::bigint)
  AND (sqlc.narg(object_type)::text IS NULL OR a.object_type = sqlc.narg(object_type)::text)
  AND (sqlc.narg(object_id)::bigint IS NULL OR a.object_id = sqlc.narg(object_id)::bigint)
  AND (
    @is_admin::boolean
    OR (a.object_type = 'post' AND (
          @is_moderator::boolean
          OR p.user_id = @viewer_id::bigint
          OR p.post_status = 'published'))
    OR (a.object_type = 'media' AND (
          @is_moderator::boolean
          OR m.user_id = @viewer_id::bigint))
  )
ORDER BY a.id DESC
LIMIT @row_limit::int;

-- name: ListContinueEditing :many
-- Home's "Continue where you left off": the posts the user last worked on, newest
-- first. "Worked on" = their created/edited/updated/version_restored/status_changed
-- events. Those are throttled, so up to one window behind; when the user is also
-- the collab server's last editor (post_ydoc_state.last_editor_id), the post's
-- changed_at is the exact time. That alone never counts: a state-only store (a
-- post merely opened) records its sender too. viewer_id 0 = may read any post,
-- else only their own and published ones (canReadPost), as the post is now.
-- Archived posts are left out.
WITH worked AS (
    SELECT a.object_id AS post_id, MAX(a.created_at)::timestamptz AS edited_at
    FROM activity a
    WHERE a.actor_id = @user_id::bigint
      AND a.object_type = 'post'
      AND a.verb IN ('created', 'edited', 'updated', 'version_restored', 'status_changed')
    GROUP BY a.object_id
)
SELECT
    p.id, p.title, p.post_type, p.post_status, p.publish_at, p.publish_failed_at,
    golive_post_has_unpublished_changes(p.id, p.post_status, p.block_doc_hash, p.published_block_hash, p.published_settings)::boolean AS has_unpublished_changes,
    GREATEST(w.edited_at, CASE WHEN s.post_id IS NOT NULL THEN p.changed_at END)::timestamptz AS edited_at,
    su.update_at AS update_at
FROM worked w
JOIN posts p ON p.id = w.post_id
LEFT JOIN post_ydoc_state s ON s.post_id = p.id AND s.last_editor_id = @user_id::bigint
-- A pending scheduled Update (#335), for the card's pill.
LEFT JOIN post_scheduled_updates su ON su.post_id = p.id
WHERE p.post_status <> 'archived'
  AND (@viewer_id::bigint = 0 OR p.user_id = @viewer_id::bigint OR p.post_status = 'published')
ORDER BY edited_at DESC, p.id DESC
LIMIT @row_limit::int;

-- name: ListFailedScheduledPosts :many
-- Home's "Needs attention" (#147): scheduled posts whose last attempt failed (the
-- scheduler keeps retrying; a success or a schedule change clears it). viewer_id
-- 0 = every post, else the viewer's own.
SELECT p.id, p.title, p.post_type, p.publish_at, p.publish_failed_at, p.publish_error, p.publish_attempts,
       COUNT(*) OVER ()::bigint AS total
FROM posts p
WHERE p.post_status = 'scheduled'
  AND p.publish_failed_at IS NOT NULL
  AND (@viewer_id::bigint = 0 OR p.user_id = @viewer_id::bigint)
ORDER BY p.publish_failed_at DESC, p.id DESC
LIMIT @row_limit::int;

-- name: ListPostsWithUnpublishedChanges :many
-- Home's "Needs attention" (#326): published posts whose working copy differs from
-- the site, most recently changed first, with the collab server's last editor.
-- total is the count before the limit.
SELECT p.id, p.title, p.post_type, p.changed_at,
       editor.id AS last_editor_id,
       editor.username AS last_editor_username,
       editor.full_name AS last_editor_full_name,
       COUNT(*) OVER ()::bigint AS total
FROM posts p
LEFT JOIN post_ydoc_state s ON s.post_id = p.id
LEFT JOIN users editor ON editor.id = s.last_editor_id
WHERE p.post_status = 'published'
  AND golive_post_has_unpublished_changes(p.id, p.post_status, p.block_doc_hash, p.published_block_hash, p.published_settings)
ORDER BY p.changed_at DESC, p.id DESC
LIMIT @row_limit::int;

-- name: DeleteActivityBefore :execrows
-- The retention prune (api/activity_retention.go): the oldest events before the
-- cutoff, a batch at a time so one run never holds a long lock.
DELETE FROM activity
WHERE id IN (
    SELECT a.id FROM activity a
    WHERE a.created_at < @cutoff::timestamptz
    ORDER BY a.id
    LIMIT @batch_size::int
);
