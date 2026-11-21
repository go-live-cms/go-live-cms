-- A commenter's export and erasure (#529, docs/design/reader-comments.md 13): by an
-- admin from the commenter's page (13.1), and by the reader from "Your comments" with a
-- mailed link (13.2). Neither the export nor a log line ever carries a hash, a key, a
-- token or network data.

-- name: ListCommenterExportComments :many
-- Every comment written with the address, in every status (unconfirmed, pending,
-- approved, spam, trash), newest first, with the post's public title and what its link
-- needs. A tombstone isn't theirs any more (its commenter is NULL), so it isn't here.
SELECT
  c.id, c.post_id, c.parent_id, c.status, c.display_name, c.body, c.notify_replies,
  c.created_at, c.approved_at, c.edited_at,
  p.post_type, p.slug,
  coalesce(p.published_settings->>'title', p.title)::text AS post_title,
  coalesce(golive_post_category_slug(p.id, true), '')::text AS category_slug
FROM reader_comments c
JOIN posts p ON p.id = c.post_id
WHERE c.commenter_id = $1
ORDER BY c.created_at DESC, c.id DESC;

-- name: GetCommenterByEmailLower :one
-- The data request (13.2): the commenter of a typed address, if there is one. Read after
-- the response only, so the answer can't tell whether there is.
SELECT * FROM commenters WHERE email_lower = $1;

-- name: CreateCommenterDataToken :one
-- A "Your comments" link (000069): only the SHA-256 of the mailed token.
INSERT INTO commenter_data_tokens (token_hash, commenter_id, expires_at)
VALUES ($1, $2, $3)
RETURNING *;

-- name: DeleteCommenterDataToken :exec
-- A link stored for a request the mail cooldown then skipped: nobody will get it.
DELETE FROM commenter_data_tokens WHERE token_hash = $1;

-- name: GetCommenterByDataToken :one
-- The commenter a "Your comments" link belongs to, while it works (an hour). Reading it
-- doesn't spend it.
SELECT c.* FROM commenter_data_tokens t
JOIN commenters c ON c.id = t.commenter_id
WHERE t.token_hash = sqlc.arg('token_hash') AND t.expires_at > now();

-- name: DeleteExpiredCommenterDataTokens :execrows
-- RunDiscussionMaintenance (6.6): links past their hour.
DELETE FROM commenter_data_tokens
WHERE token_hash IN (
  SELECT t.token_hash FROM commenter_data_tokens t
  WHERE t.expires_at < sqlc.arg('now')::timestamptz
  FOR UPDATE OF t SKIP LOCKED
);

-- name: LockCommenter :one
-- Erasure: the commenter first. A new comment for the address waits on this lock (its
-- foreign key check) and fails once the row is gone.
SELECT * FROM commenters WHERE id = $1 FOR UPDATE;

-- name: LockCommenterThreads :many
-- Erasure: every row of every thread one of the commenter's comments is in, in id order.
-- A moderator's status change share-locks a comment's root and parent before the row
-- (ModerateReaderCommentTx), and roots and parents are older than what answers them, so
-- taking them all here in the same order means the two never deadlock, and a reply
-- approved meanwhile is seen before deciding what becomes a tombstone.
SELECT r.id FROM reader_comments r
WHERE r.commenter_id = sqlc.arg('commenter_id')
   OR r.id IN (SELECT coalesce(x.root_id, x.id) FROM reader_comments x WHERE x.commenter_id = sqlc.arg('commenter_id'))
   OR r.root_id IN (SELECT coalesce(x.root_id, x.id) FROM reader_comments x WHERE x.commenter_id = sqlc.arg('commenter_id'))
ORDER BY r.id
FOR UPDATE OF r;

-- name: ListCommenterCommentIDs :many
-- Erasure: the commenter's comments, newest first, so a reply is removed before the
-- comment it answers and the tombstones left are exactly the comments that someone
-- else's approved replies still answer.
SELECT id FROM reader_comments WHERE commenter_id = $1 ORDER BY id DESC;

-- name: ScrubDiscussionMailComments :many
-- Erasure: the erased comments leave every outbox row that names them (other members'
-- author mail, a moderation mail's count). Each row says whether it is left with nothing
-- to send: an author row not yet claimed by the sender, which erasure then deletes. A
-- moderation row is the queue's record (its ids are what the next mail compares with),
-- and a claimed row is built from the current data and dropped by the sender.
UPDATE discussion_mail m
SET comment_ids = ARRAY(SELECT x FROM unnest(m.comment_ids) AS x WHERE x <> ALL (sqlc.arg('ids')::bigint[]))
WHERE m.comment_ids && sqlc.arg('ids')::bigint[]
RETURNING m.id, (
  cardinality(m.comment_ids) = 0 AND m.done_at IS NULL AND m.kind <> 'moderation'
  AND (m.claimed_until IS NULL OR m.claimed_until <= now())
)::boolean AS empty;

-- name: DeleteDiscussionMailRows :execrows
DELETE FROM discussion_mail WHERE id = ANY (sqlc.arg('ids')::bigint[]);

-- name: DeleteCommenter :execrows
-- Erasure's last step: the row with the address. Its browser keys, "Your comments"
-- links and its own outbox rows (reply mail) go with it (ON DELETE CASCADE).
DELETE FROM commenters WHERE id = $1;
