-- Scheduled publishing (#147, 000033). The scheduler is api/scheduled_publish.go;
-- the publish itself is PublishScheduledPostTx (db/sqlc/post_publish_tx.go).

-- name: SchedulePost :one
-- Schedules a draft, or moves a scheduled post to a new time. No row: the post is
-- missing or neither a draft nor scheduled (a published post's update is #335). A
-- new time starts over: no attempts, no failure and no claim, so a publish still
-- in flight for the old time is fenced off.
UPDATE posts
SET post_status = 'scheduled',
    publish_at = sqlc.arg(publish_at)::timestamptz,
    publish_scheduled_by = sqlc.narg(scheduled_by)::bigint,
    publish_attempts = 0,
    publish_next_attempt_at = NULL,
    publish_failed_at = NULL,
    publish_error = NULL
WHERE id = sqlc.arg(id)::bigint
  AND post_status IN ('draft', 'scheduled')
RETURNING *;

-- name: CancelPostSchedule :one
-- Unscheduling: back to draft, the time cleared. No row: not scheduled (or missing).
UPDATE posts
SET post_status = 'draft',
    publish_at = NULL,
    publish_scheduled_by = NULL,
    publish_attempts = 0,
    publish_next_attempt_at = NULL,
    publish_failed_at = NULL,
    publish_error = NULL
WHERE id = $1
  AND post_status = 'scheduled'
RETURNING *;

-- name: ClaimDueScheduledPosts :many
-- Claims up to max_posts due scheduled posts for this replica: FOR UPDATE SKIP
-- LOCKED, so two replicas running it at once never pick the same row, and the
-- claim (publish_next_attempt_at = now + lease) makes the others skip it until
-- the lease ends, which only matters if this replica dies mid-publish. The
-- returned publish_next_attempt_at is the claim's fencing token. A row locked by
-- something else (a collab store) is skipped this round, not waited for.
UPDATE posts p
SET publish_attempts = p.publish_attempts + 1,
    publish_next_attempt_at = now() + make_interval(secs => sqlc.arg(lease_seconds)::double precision)
FROM (
    SELECT d.id
    FROM posts d
    WHERE d.post_status = 'scheduled'
      AND d.publish_at <= now()
      AND (d.publish_next_attempt_at IS NULL OR d.publish_next_attempt_at <= now())
    ORDER BY d.publish_at, d.id
    LIMIT sqlc.arg(max_posts)::int
    FOR UPDATE SKIP LOCKED
) due
WHERE p.id = due.id
RETURNING p.id, p.publish_at, p.publish_attempts, p.publish_next_attempt_at AS claim, p.publish_scheduled_by;

-- name: LockScheduledPostClaim :one
-- Inside PublishScheduledPostTx: the post, locked, if it is still scheduled under
-- this claim. No row: it was cancelled, rescheduled, published by hand, deleted
-- or claimed again after this claim's lease ran out; nothing is published.
SELECT id, publish_scheduled_by
FROM posts
WHERE id = sqlc.arg(id)::bigint
  AND post_status = 'scheduled'
  AND publish_next_attempt_at = sqlc.arg(claim)::timestamptz
FOR UPDATE;

-- name: RecordScheduledPublishFailure :execrows
-- A failed attempt under this claim: the reason the editor shows, and the next try
-- after the backoff. 0 rows: the schedule changed meanwhile, nothing to record.
UPDATE posts
SET publish_failed_at = now(),
    publish_error = sqlc.arg(reason)::text,
    publish_next_attempt_at = now() + make_interval(secs => sqlc.arg(retry_after_seconds)::double precision)
WHERE id = sqlc.arg(id)::bigint
  AND post_status = 'scheduled'
  AND publish_next_attempt_at = sqlc.arg(claim)::timestamptz;
