-- Reader comment mail (#528, docs/design/reader-comments.md 8; api/discussion_mail.go).
-- The reply and author rows are written by 000068's trigger, in the approving
-- transaction; these queries claim, build, finish and prune them, queue moderation mail
-- and serve unsubscribing and members' preferences.

-- name: ClaimDueDiscussionMail :many
-- Claims up to max_rows due rows for this replica (FOR UPDATE SKIP LOCKED, then a lease,
-- as ClaimDueReminders). claimed_until is the claim's fencing token. A claimed row
-- (attempts > 0) takes no more comments: the next one opens a new row.
UPDATE discussion_mail m
SET attempts = m.attempts + 1,
    claimed_until = now() + make_interval(secs => sqlc.arg(lease_seconds)::double precision)
FROM (
    SELECT d.id
    FROM discussion_mail d
    WHERE d.done_at IS NULL
      AND d.due_at <= now()
      AND (d.claimed_until IS NULL OR d.claimed_until <= now())
    ORDER BY d.due_at, d.id
    LIMIT sqlc.arg(max_rows)::int
    FOR UPDATE SKIP LOCKED
) due
WHERE m.id = due.id
RETURNING m.id, m.kind, m.commenter_id, m.user_id, m.answered_id, m.comment_ids, m.attempts,
  m.claimed_until AS claim;

-- name: FinishDiscussionMail :execrows
-- Ends a claimed row (sent, dropped, or failed for good), only under this claim.
-- comment_ids, when given, replaces the row's (a moderation mail records the pending
-- comments it counted, so the next one says only what is new).
UPDATE discussion_mail
SET outcome = sqlc.arg(outcome)::text,
    done_at = now(),
    claimed_until = NULL,
    comment_ids = coalesce(sqlc.narg(comment_ids)::bigint[], comment_ids)
WHERE id = sqlc.arg(id) AND done_at IS NULL AND claimed_until = sqlc.arg(claim)::timestamptz;

-- name: ReleaseDiscussionMail :execrows
-- Gives a claimed row back for a retry at retry_at (a failed send), under this claim.
UPDATE discussion_mail
SET claimed_until = sqlc.arg(retry_at)::timestamptz
WHERE id = sqlc.arg(id) AND done_at IS NULL AND claimed_until = sqlc.arg(claim)::timestamptz;

-- name: PruneDiscussionMail :execrows
-- Finished rows go after 7 days (8.4): ids only, but no reason to keep them.
DELETE FROM discussion_mail
WHERE id IN (
    SELECT d.id FROM discussion_mail d
    WHERE d.done_at IS NOT NULL AND d.done_at < sqlc.arg(done_before)::timestamptz
    ORDER BY d.id
    LIMIT 5000
    FOR UPDATE SKIP LOCKED
);

-- name: EnqueueModerationMail :execrows
-- "Comments await moderation" (8.1), due now, for every editor and admin who wants it,
-- when the queue holds a pending comment their latest sent mail didn't count (each one
-- records the whole pending queue it counted), and they had none sent or failed in the
-- last hour ("each hour at most", 8.3: a failing address isn't retried every round) and
-- have none waiting. The open-row index makes a second replica's insert a no-op. Nothing
-- is queued per comment: the queue itself is the durable fact, so a moderation mail can't
-- be lost to a rollback.
INSERT INTO discussion_mail (kind, user_id, comment_ids, due_at)
SELECT 'moderation', u.id, '{}'::bigint[], now()
FROM users u
WHERE u.role IN ('admin', 'editor')
  AND u.notify_comment_moderation = 'hourly'
  AND u.email <> ''
  AND NOT EXISTS (
      SELECT 1 FROM discussion_mail m
      WHERE m.kind = 'moderation' AND m.user_id = u.id
        AND (m.done_at IS NULL OR (m.outcome IN ('sent', 'failed') AND m.done_at > now() - interval '1 hour'))
  )
  AND EXISTS (
      SELECT 1 FROM reader_comments rc
      WHERE rc.status = 'pending' AND rc.removed_at IS NULL
        AND rc.id <> ALL (coalesce((
            SELECT m.comment_ids FROM discussion_mail m
            WHERE m.kind = 'moderation' AND m.user_id = u.id AND m.outcome = 'sent'
            ORDER BY m.done_at DESC, m.id DESC
            LIMIT 1
        ), '{}'::bigint[]))
  )
ON CONFLICT DO NOTHING;

-- name: ListDiscussionMailComments :many
-- What a mail says about its comments, read when it is built (8.4): their state now, and
-- the post's, so a comment trashed, a post unpublished or a member taken off the byline
-- meanwhile is left out. name is a member's current name. on_byline: member_id is on the
-- post's published byline.
SELECT rc.id, rc.post_id, rc.parent_id, rc.commenter_id, rc.author_user_id, rc.status,
  (rc.removed_at IS NOT NULL)::boolean AS removed,
  coalesce(nullif(u.full_name, ''), nullif(u.username, ''), rc.display_name)::text AS name,
  rc.body, rc.created_at,
  p.post_type, p.slug, p.post_status, p.discussion, p.first_published_at,
  coalesce(p.published_settings->>'title', p.title)::text AS post_title,
  coalesce(golive_post_category_slug(p.id, true), '')::text AS category_slug,
  EXISTS (
      SELECT 1 FROM post_published_authors a
      WHERE a.post_id = rc.post_id AND a.user_id = sqlc.arg(member_id)::bigint
  )::boolean AS on_byline
FROM reader_comments rc
JOIN posts p ON p.id = rc.post_id
LEFT JOIN users u ON u.id = rc.author_user_id
WHERE rc.id = ANY (sqlc.arg(ids)::bigint[])
ORDER BY rc.created_at, rc.id;

-- name: ListPendingReaderCommentIDs :many
-- The moderation queue's Pending tab, as ids (a moderation mail's count).
SELECT id FROM reader_comments
WHERE status = 'pending' AND removed_at IS NULL
ORDER BY id;

-- name: ListNewestPendingCommentPosts :many
-- The posts with the newest pending comments, newest first (a moderation mail names
-- three, 8.1). Titles as the admin shows them.
SELECT p.id, p.title, max(rc.created_at)::timestamptz AS newest
FROM reader_comments rc
JOIN posts p ON p.id = rc.post_id
WHERE rc.status = 'pending' AND rc.removed_at IS NULL
GROUP BY p.id, p.title
ORDER BY newest DESC, p.id DESC
LIMIT sqlc.arg(max_rows)::int;

-- name: CreateReaderCommentUnsubscribeToken :exec
-- A reply mail's unsubscribe token (8.2), minted when the mail is built: only its hash is
-- kept, so each mail brings its own. It goes with the comment.
INSERT INTO reader_comment_unsubscribe_tokens (token_hash, comment_id)
VALUES (sqlc.arg(token_hash), sqlc.arg(comment_id));

-- name: DeleteReaderCommentUnsubscribeToken :exec
-- A token whose mail was never delivered (the send failed): nobody holds it.
DELETE FROM reader_comment_unsubscribe_tokens WHERE token_hash = sqlc.arg(token_hash);

-- name: GetReaderCommentByUnsubscribeToken :one
-- The comment an unsubscribe token turns off, and its commenter (for "Stop all mail").
SELECT rc.id, rc.commenter_id, rc.post_id
FROM reader_comment_unsubscribe_tokens t
JOIN reader_comments rc ON rc.id = t.comment_id
WHERE t.token_hash = sqlc.arg(token_hash);

-- name: UnsubscribeReaderComment :execrows
-- "Stop these emails": that comment's replies are no longer mailed.
UPDATE reader_comments SET notify_replies = false
WHERE id = sqlc.arg(id) AND notify_replies;

-- name: UnsubscribeCommenter :execrows
-- "Stop all mail from this site": every subscription of the commenter.
UPDATE reader_comments SET notify_replies = false
WHERE commenter_id = sqlc.arg(commenter_id) AND notify_replies;

-- name: GetUserNotifications :one
-- Profile's Notifications (8.3).
SELECT notify_post_comments, notify_comment_moderation FROM users WHERE id = sqlc.arg(id);

-- name: UpdateUserNotifications :one
UPDATE users
SET notify_post_comments = sqlc.arg(notify_post_comments),
    notify_comment_moderation = sqlc.arg(notify_comment_moderation)
WHERE id = sqlc.arg(id)
RETURNING notify_post_comments, notify_comment_moderation;

-- name: RetimeAuthorMail :execrows
-- A member's open author row follows a change of "Comments on my posts": due five
-- minutes after the change (each), or at the next digest. Off leaves it: the sender
-- drops it, as it drops anything a preference no longer asks for.
UPDATE discussion_mail
SET due_at = CASE
    WHEN sqlc.arg(preference)::text = 'each' THEN least(due_at, now() + interval '5 minutes')
    ELSE golive_discussion_digest_at(now())
  END
WHERE kind = 'author' AND user_id = sqlc.arg(user_id)::bigint AND done_at IS NULL AND attempts = 0;
