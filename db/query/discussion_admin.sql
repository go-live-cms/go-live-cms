-- Discussion in the admin (#526, C6; docs/design/reader-comments.md 3.4, 4.4, 7.1, 9.3).
--
-- What moderators (editors and admins) read and write: the queue, a comment's thread,
-- commenters, and members' own comments. Unconfirmed comments are never here (they
-- aren't moderated, 4.1). A commenter's address is selected for moderators only
-- (decision 6): the handlers answer it to /discussion callers and never log it.

-- name: ListModerationComments :many
-- One query for the queue (a status, newest first), a thread (root_id, every status,
-- oldest first, tombstones included), a commenter's comments and one comment (id).
-- "New commenter" = a reader with nothing approved yet. A member's comment carries their
-- current name and avatar and whether they are on the post's published byline (the
-- Author badge, 3.4); a removed member's has neither (author_user_id is NULL).
-- pattern is an ILIKE pattern ('' = no search) over the text and the name.
SELECT
  c.id, c.post_id, c.parent_id, c.root_id, c.commenter_id, c.author_user_id,
  c.display_name, c.body, c.status, c.trashed_from, c.held_reason, c.held_detail,
  c.notify_replies, c.created_at, c.approved_at, c.moderated_at, c.edited_at, c.removed_at,
  coalesce(cm.email, '')::text AS commenter_email,
  (cm.id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM reader_comments x WHERE x.commenter_id = cm.id AND x.status = 'approved'
  ))::boolean AS new_commenter,
  (cm.blocked_at IS NOT NULL)::boolean AS commenter_blocked,
  (u.id IS NOT NULL)::boolean AS by_member,
  coalesce(nullif(btrim(u.full_name), ''), u.username, '')::text AS member_name,
  coalesce(u.avatar_url, '')::text AS member_avatar,
  (u.id IS NOT NULL AND EXISTS (
    SELECT 1 FROM post_published_authors pa WHERE pa.post_id = c.post_id AND pa.user_id = c.author_user_id
  ))::boolean AS member_is_author,
  coalesce(nullif(btrim(pu.full_name), ''), pu.username, par.display_name, '')::text AS parent_name,
  p.title AS post_title, p.post_type, p.slug AS post_slug, p.post_status,
  coalesce(golive_post_category_slug(p.id, true), '')::text AS post_category_slug,
  coalesce(nullif(btrim(mu.full_name), ''), mu.username, '')::text AS moderated_by_name
FROM reader_comments c
JOIN posts p ON p.id = c.post_id
LEFT JOIN commenters cm ON cm.id = c.commenter_id
LEFT JOIN users u ON u.id = c.author_user_id
LEFT JOIN reader_comments par ON par.id = c.parent_id
LEFT JOIN users pu ON pu.id = par.author_user_id
LEFT JOIN users mu ON mu.id = c.moderated_by
WHERE c.status <> 'unconfirmed'
  AND (sqlc.narg('id')::bigint IS NULL OR c.id = sqlc.narg('id')::bigint)
  AND (sqlc.narg('status')::text IS NULL OR c.status = sqlc.narg('status')::text)
  AND (sqlc.narg('post_id')::bigint IS NULL OR c.post_id = sqlc.narg('post_id')::bigint)
  AND (sqlc.narg('commenter_id')::bigint IS NULL OR c.commenter_id = sqlc.narg('commenter_id')::bigint)
  AND (sqlc.narg('root_id')::bigint IS NULL OR c.id = sqlc.narg('root_id')::bigint OR c.root_id = sqlc.narg('root_id')::bigint)
  -- A tombstone is only part of a thread, never a row of the queue.
  AND (c.removed_at IS NULL OR sqlc.narg('root_id')::bigint IS NOT NULL OR sqlc.narg('id')::bigint IS NOT NULL)
  AND (sqlc.arg('pattern')::text = '' OR c.body ILIKE sqlc.arg('pattern')::text OR c.display_name ILIKE sqlc.arg('pattern')::text)
ORDER BY
  CASE WHEN sqlc.arg('oldest_first')::boolean THEN c.created_at END ASC,
  CASE WHEN sqlc.arg('oldest_first')::boolean THEN c.id END ASC,
  c.created_at DESC,
  c.id DESC
LIMIT sqlc.arg('limit_count')::int OFFSET sqlc.arg('offset_count')::int;

-- name: CountModerationComments :many
-- The queue's tab counts (GET /discussion/counts), following the same filters as the
-- list, so "Pending 2 · Approved 12 on this post" (16.1). Tombstones aren't counted.
SELECT c.status, count(*)::bigint AS count
FROM reader_comments c
WHERE c.status IN ('pending', 'approved', 'spam', 'trash')
  AND c.removed_at IS NULL
  AND (sqlc.narg('post_id')::bigint IS NULL OR c.post_id = sqlc.narg('post_id')::bigint)
  AND (sqlc.narg('commenter_id')::bigint IS NULL OR c.commenter_id = sqlc.narg('commenter_id')::bigint)
  AND (sqlc.arg('pattern')::text = '' OR c.body ILIKE sqlc.arg('pattern')::text OR c.display_name ILIKE sqlc.arg('pattern')::text)
GROUP BY c.status;

-- name: GetPendingReaderCommentsSummary :one
-- Home's Needs attention (4.4, 16.1): "4 comments await moderation", on how many posts
-- and how old the oldest is. oldest_at is now() when nothing waits.
SELECT
  count(*)::bigint AS count,
  count(DISTINCT post_id)::bigint AS post_count,
  coalesce(min(created_at), now())::timestamptz AS oldest_at
FROM reader_comments
WHERE status = 'pending';

-- name: ModerateReaderComment :one
-- A moderator's status change (approve, unapprove, spam, not spam): from one of
-- from_statuses only, never on a tombstone. held_reason is what the queue shows next
-- (moderator for a moderator's Spam, previous_spam for Not spam, 16.1; NULL otherwise).
UPDATE reader_comments
SET status = sqlc.arg('status')::text,
    held_reason = sqlc.narg('held_reason'),
    held_detail = NULL,
    approved_at = CASE WHEN sqlc.arg('status')::text = 'approved' THEN now() ELSE approved_at END,
    moderated_by = sqlc.narg('moderated_by'),
    moderated_at = now()
WHERE id = sqlc.arg('id')
  AND status = ANY(sqlc.arg('from_statuses')::text[])
  AND removed_at IS NULL
RETURNING *;

-- name: MarkCommenterSpammed :exec
-- 4.2 previous_spam: a moderator's Spam holds the commenter's comments for 90 days
-- (the rules themselves never set it, 16.2).
UPDATE commenters SET last_spam_at = now() WHERE id = $1;

-- name: UpdateMemberReaderComment :one
-- 6.4: a member edits their own comment only; it shows "Edited".
UPDATE reader_comments
SET body = sqlc.arg('body'),
    edited_at = now()
WHERE id = sqlc.arg('id')
  AND author_user_id = sqlc.arg('author_user_id')
  AND removed_at IS NULL
  AND status <> 'unconfirmed'
RETURNING *;

-- name: GetCommenterModeration :one
-- A commenter's page (13.1, 16.1): the row, who blocked them, the counts by status, how
-- many comments ask for reply mail, the names used, and how many other commenters
-- posted from one of their networks (7.2: the hashes live 30 days).
SELECT
  c.id, c.email, c.display_name, c.verified_at, c.blocked_at, c.last_spam_at,
  c.created_at, c.last_seen_at,
  coalesce(nullif(btrim(b.full_name), ''), b.username, '')::text AS blocked_by_name,
  (SELECT count(*) FROM reader_comments r WHERE r.commenter_id = c.id AND r.status = 'approved' AND r.removed_at IS NULL)::bigint AS approved_count,
  (SELECT count(*) FROM reader_comments r WHERE r.commenter_id = c.id AND r.status = 'pending')::bigint AS pending_count,
  (SELECT count(*) FROM reader_comments r WHERE r.commenter_id = c.id AND r.status = 'spam')::bigint AS spam_count,
  (SELECT count(*) FROM reader_comments r WHERE r.commenter_id = c.id AND r.status = 'trash')::bigint AS trash_count,
  -- Erase deletes these too (#529): its confirmation counts them.
  (SELECT count(*) FROM reader_comments r WHERE r.commenter_id = c.id AND r.status = 'unconfirmed')::bigint AS unconfirmed_count,
  (SELECT count(*) FROM reader_comments r WHERE r.commenter_id = c.id AND r.notify_replies AND r.status <> 'unconfirmed')::bigint AS notify_count,
  coalesce((
    SELECT array_agg(DISTINCT r.display_name ORDER BY r.display_name) FROM reader_comments r
    WHERE r.commenter_id = c.id AND r.status <> 'unconfirmed' AND r.display_name <> ''
  ), '{}')::text[] AS names_used,
  (
    SELECT count(DISTINCT o.commenter_id) FROM reader_comments o
    WHERE o.commenter_id IS NOT NULL AND o.commenter_id <> c.id
      AND o.network_hash IN (
        SELECT h.network_hash FROM reader_comments h
        WHERE h.commenter_id = c.id AND h.network_hash IS NOT NULL
      )
  )::bigint AS network_neighbours
FROM commenters c
LEFT JOIN users b ON b.id = c.blocked_by
WHERE c.id = $1;

-- name: GetCommenterIDByEmail :one
-- Find a commenter (16.1): by the whole address only, so the queue can't be fished.
SELECT id FROM commenters WHERE email_lower = $1;
