-- Scheduled updates to published posts (#335, 000035). The handlers are
-- api/posts_scheduled_update.go; the scheduler is api/scheduled_publish.go (#147's),
-- and the apply itself is PublishScheduledUpdateTx (db/sqlc/post_publish_tx.go).

-- name: GetPostStatus :one
-- PUT /posts/:id/scheduled-update's check before the collab flush: the status
-- alone, without reading the post's body.
SELECT post_status FROM posts WHERE id = $1;

-- name: LockPostStatusForUpdate :one
-- ScheduleUpdateTx's first step: lock the post (as LockPostForPublish) and read
-- its status under the lock.
SELECT post_status FROM posts WHERE id = $1 FOR UPDATE;

-- name: UpsertScheduledUpdateFromPost :one
-- Inside ScheduleUpdateTx, with the post locked: freeze the working copy as it is
-- stored now (after the handler's collab flush), body and settings from the same
-- row, as InsertPublishedVersionFromPost reads them. A new schedule replaces the old
-- one whole: a new snapshot, a new time, no attempts, failure or claim, so an apply
-- in flight for the old one is fenced off. No row: the post isn't published.
INSERT INTO post_scheduled_updates (post_id, update_at, block_doc, settings, scheduled_by)
SELECT p.id, sqlc.arg(update_at)::timestamptz, p.block_doc, golive_post_settings(p.id), sqlc.narg(scheduled_by)::bigint
FROM posts p
WHERE p.id = sqlc.arg(post_id)::bigint
  AND p.post_status = 'published'
ON CONFLICT (post_id) DO UPDATE
SET update_at = EXCLUDED.update_at,
    block_doc = EXCLUDED.block_doc,
    settings = EXCLUDED.settings,
    scheduled_by = EXCLUDED.scheduled_by,
    attempts = 0,
    next_attempt_at = NULL,
    failed_at = NULL,
    error = NULL,
    created_at = now()
RETURNING post_id, update_at, scheduled_by, attempts, next_attempt_at, failed_at, error, created_at;

-- name: GetPostScheduledUpdate :one
-- A post's pending update without its snapshot: GET /posts/:id's scheduled_update.
SELECT post_id, update_at, scheduled_by, attempts, next_attempt_at, failed_at, error, created_at
FROM post_scheduled_updates
WHERE post_id = $1;

-- name: CancelPostScheduledUpdate :execrows
-- "Cancel update": the snapshot is dropped, the live post and the working copy stay
-- as they are. 0 rows: nothing was scheduled. An apply in flight is fenced off
-- (LockScheduledUpdateClaim finds no row).
DELETE FROM post_scheduled_updates
WHERE post_id = $1;

-- name: ClaimDueScheduledUpdates :many
-- ClaimDueScheduledPosts (#147) for updates: up to max_posts due rows, FOR UPDATE
-- SKIP LOCKED so two replicas never take the same one, and a lease
-- (next_attempt_at) so the others skip it until it ends. The returned
-- next_attempt_at is the claim's fencing token.
UPDATE post_scheduled_updates s
SET attempts = s.attempts + 1,
    next_attempt_at = now() + make_interval(secs => sqlc.arg(lease_seconds)::double precision)
FROM (
    SELECT d.post_id
    FROM post_scheduled_updates d
    WHERE d.update_at <= now()
      AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= now())
    ORDER BY d.update_at, d.post_id
    LIMIT sqlc.arg(max_posts)::int
    FOR UPDATE OF d SKIP LOCKED
) due
WHERE s.post_id = due.post_id
RETURNING s.post_id, s.update_at, s.attempts, s.next_attempt_at AS claim, s.scheduled_by;

-- name: LockScheduledUpdateClaim :one
-- Inside PublishScheduledUpdateTx, after the post's row lock: the pending update,
-- locked, if it is still the one this claim took and the post is still published. No
-- row: cancelled, rescheduled (a new snapshot), applied, superseded by an Update by
-- hand or an unpublish (the 000035 trigger deletes it), or claimed again after this
-- claim's lease ran out. Nothing is published then.
SELECT s.post_id, s.scheduled_by
FROM post_scheduled_updates s
JOIN posts p ON p.id = s.post_id
WHERE s.post_id = sqlc.arg(post_id)::bigint
  AND s.next_attempt_at = sqlc.arg(claim)::timestamptz
  AND p.post_status = 'published'
FOR UPDATE OF s;

-- name: InsertPublishedVersionFromScheduledUpdate :one
-- The scheduled update's version: its frozen body and settings, credited to whoever
-- scheduled it. Never the working copy (#335: later edits aren't included).
INSERT INTO post_versions (post_id, version_no, status, block_doc, settings, created_by)
SELECT s.post_id, sqlc.arg(version_no)::int, 'published', s.block_doc, s.settings, s.scheduled_by
FROM post_scheduled_updates s
WHERE s.post_id = sqlc.arg(post_id)::bigint
RETURNING id, version_no, block_doc;

-- name: RecordScheduledUpdateFailure :execrows
-- RecordScheduledPublishFailure for updates: the reason the editor shows and the
-- next try after the backoff. 0 rows: the schedule changed meanwhile.
UPDATE post_scheduled_updates
SET failed_at = now(),
    error = sqlc.arg(reason)::text,
    next_attempt_at = now() + make_interval(secs => sqlc.arg(retry_after_seconds)::double precision)
WHERE post_id = sqlc.arg(post_id)::bigint
  AND next_attempt_at = sqlc.arg(claim)::timestamptz;
