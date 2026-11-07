-- @ mentions, content links and date reminders (#320, 000050; api/mentions.go,
-- api/inline_nodes.go, api/mention_notifications.go, api/reminders.go).

-- name: ListMentionCandidates :many
-- The @ menu's People: members with one of @roles (the content roles) matching @pattern
-- by name or username (ILIKE, '' = everyone), by name. Public fields only.
SELECT id, username, full_name, avatar_url, role
FROM users
WHERE lower(role) = ANY(sqlc.arg(roles)::text[])
    AND (sqlc.arg(pattern)::text = '' OR full_name ILIKE sqlc.arg(pattern) OR username ILIKE sqlc.arg(pattern))
ORDER BY lower(full_name), username, id
LIMIT sqlc.arg(limit_count)::int;

-- name: ListMentionPeopleByIDs :many
-- Members by id (the editor's current names; the public API's mention names). A removed
-- member has no row.
SELECT id, username, full_name, avatar_url, role
FROM users
WHERE id = ANY(sqlc.arg(ids)::bigint[])
ORDER BY id;

-- name: ListMentionContent :many
-- The @ menu's "Link to post or page": posts the viewer may read (@viewer_id 0 = a
-- moderator, every post; else their own and published ones, canReadPost), never one in
-- the trash, whose title matches @pattern ('' = all), the latest edited first.
SELECT p.id, p.title, p.post_type, p.post_status
FROM posts p
WHERE p.post_status <> 'trash'
    AND (@viewer_id::bigint = 0 OR p.user_id = @viewer_id OR p.post_status = 'published')
    AND (sqlc.arg(pattern)::text = '' OR p.title ILIKE sqlc.arg(pattern))
ORDER BY p.changed_at DESC, p.id DESC
LIMIT sqlc.arg(limit_count)::int;

-- name: ListContentLinkTargets :many
-- The posts content links point at, for the public API: what their current URL is built
-- from (the published category, #331) and whether they're shown at all (published, of a
-- public and active type).
SELECT p.id, p.slug, p.post_type, p.post_status,
    coalesce(golive_post_category_slug(p.id, true), '')::text AS category_slug,
    coalesce(pt.public, false)::boolean AS type_public,
    coalesce(pt.is_active, false)::boolean AS type_active
FROM posts p
LEFT JOIN post_types pt ON pt.name = p.post_type
WHERE p.id = ANY(sqlc.arg(ids)::bigint[]);

-- name: RecordPostMentions :many
-- Adds the members a store mentions that the ledger doesn't have for this post (parallel
-- arrays, one entry per member: the block, the member, who typed it, 0 = nobody known) and
-- returns only the rows it inserted: a member already recorded is never notified again. A member who no longer exists is left out.
-- Runs inside StorePostCollabTx.
WITH mentions AS (
    SELECT b.block_id, u.user_id, m.mentioned_by
    FROM unnest(@block_ids::text[]) WITH ORDINALITY AS b(block_id, ord)
    JOIN unnest(@user_ids::bigint[]) WITH ORDINALITY AS u(user_id, ord) ON u.ord = b.ord
    JOIN unnest(@mentioned_by::bigint[]) WITH ORDINALITY AS m(mentioned_by, ord) ON m.ord = b.ord
)
INSERT INTO post_mention_notifications (post_id, block_id, user_id, mentioned_by)
SELECT @post_id, mentions.block_id, users.id, by_user.id
FROM mentions
JOIN users ON users.id = mentions.user_id
LEFT JOIN users by_user ON by_user.id = mentions.mentioned_by
ON CONFLICT (post_id, user_id) DO NOTHING
RETURNING post_id, block_id, user_id, mentioned_by;

-- name: MarkMentionsEmailed :exec
-- The ledger rows whose email went out.
UPDATE post_mention_notifications
SET emailed = true
WHERE post_id = @post_id AND user_id = ANY(@user_ids::bigint[]);

-- name: ListPostMentionNotifications :many
-- A post's ledger (tests and support).
SELECT post_id, block_id, user_id, mentioned_by, emailed, created_at
FROM post_mention_notifications
WHERE post_id = $1
ORDER BY block_id, user_id;

-- name: DeleteStalePostReminders :exec
-- A store's reminders replace the post's pending ones: a pending row whose chip is gone
-- (removed, or moved to another time: keys are "<block_id> <remind_at as RFC 3339>") is
-- deleted. Sent, skipped and failed rows stay, so a chip never fires twice. Runs inside
-- StorePostCollabTx, like AddPostReminders.
DELETE FROM post_reminders
WHERE post_id = @post_id
    AND status = 'pending'
    AND NOT ((block_id || ' ' || to_char(remind_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) = ANY(@keep_keys::text[]));

-- name: AddPostReminders :many
-- The store's new reminders (parallel arrays; remind_ats as RFC 3339 text), each owned by
-- whoever wrote it. One already recorded for the same block and time is left as it is
-- (its owner and status). Returns the rows it inserted.
WITH reminders AS (
    SELECT b.block_id, r.remind_at::timestamptz AS remind_at, d.chip_date::date AS chip_date, t.chip_time, u.user_id
    FROM unnest(@block_ids::text[]) WITH ORDINALITY AS b(block_id, ord)
    JOIN unnest(@remind_ats::text[]) WITH ORDINALITY AS r(remind_at, ord) ON r.ord = b.ord
    JOIN unnest(@chip_dates::text[]) WITH ORDINALITY AS d(chip_date, ord) ON d.ord = b.ord
    JOIN unnest(@chip_times::text[]) WITH ORDINALITY AS t(chip_time, ord) ON t.ord = b.ord
    JOIN unnest(@user_ids::bigint[]) WITH ORDINALITY AS u(user_id, ord) ON u.ord = b.ord
)
INSERT INTO post_reminders (post_id, block_id, remind_at, chip_date, chip_time, user_id)
SELECT @post_id, reminders.block_id, reminders.remind_at, reminders.chip_date, reminders.chip_time, users.id
FROM reminders
JOIN users ON users.id = reminders.user_id
ON CONFLICT (post_id, block_id, remind_at) DO NOTHING
RETURNING id, post_id, block_id, remind_at, user_id;

-- name: ListPostReminders :many
-- A post's reminders (tests and support).
SELECT id, post_id, block_id, remind_at, chip_date, chip_time, user_id, status, attempts, done_at
FROM post_reminders
WHERE post_id = $1
ORDER BY remind_at, block_id;

-- name: ClaimDueReminders :many
-- Claims up to max_rows due pending reminders for this replica (FOR UPDATE SKIP LOCKED,
-- then a lease, as ClaimDueScheduledPosts). claimed_until is the claim's fencing token.
UPDATE post_reminders r
SET attempts = r.attempts + 1,
    claimed_until = now() + make_interval(secs => sqlc.arg(lease_seconds)::double precision)
FROM (
    SELECT d.id
    FROM post_reminders d
    WHERE d.status = 'pending'
      AND d.remind_at <= now()
      AND (d.claimed_until IS NULL OR d.claimed_until <= now())
    ORDER BY d.remind_at, d.id
    LIMIT sqlc.arg(max_rows)::int
    FOR UPDATE SKIP LOCKED
) due
WHERE r.id = due.id
RETURNING r.id, r.post_id, r.block_id, r.remind_at, r.chip_date, r.chip_time, r.user_id, r.attempts, r.claimed_until AS claim;

-- name: FinishReminder :execrows
-- Ends a claimed reminder (sent, skipped, or failed for good), only under this claim.
UPDATE post_reminders
SET status = sqlc.arg(status)::text, done_at = now(), claimed_until = NULL
WHERE id = sqlc.arg(id) AND status = 'pending' AND claimed_until = sqlc.arg(claim)::timestamptz;

-- name: ReleaseReminder :execrows
-- Gives a claimed reminder back for a retry at retry_at (a failed send), under this claim.
UPDATE post_reminders
SET claimed_until = sqlc.arg(retry_at)::timestamptz
WHERE id = sqlc.arg(id) AND status = 'pending' AND claimed_until = sqlc.arg(claim)::timestamptz;
