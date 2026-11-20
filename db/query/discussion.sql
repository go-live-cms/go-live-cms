-- Reader comments (#499; storage #522, 000061). docs/design/reader-comments.md 6, 12.
-- Never #192's post_comments: every name here says reader comment, commenter or
-- discussion.

-- name: UpdatePostDiscussion :one
-- 12.3: the post's Discussion choice. Outside the publish snapshot: it isn't in
-- golive_post_settings(), and changed_at stays (a discussion change isn't an edit, so it
-- fires no post.saved plugin event and doesn't reorder "recently edited").
UPDATE posts
SET discussion = sqlc.arg('discussion')
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: SetPostTypeComments :one
-- 12.2: the one field of a built-in type's supports PUT /post-types/:name may change.
-- Adds or removes "comments", keeping the other entries and their order.
UPDATE post_types
SET supports = CASE
    WHEN sqlc.arg('enabled')::boolean THEN
      CASE WHEN supports ? 'comments' THEN supports ELSE supports || '["comments"]'::jsonb END
    ELSE supports - 'comments'
  END
WHERE name = sqlc.arg('name')
RETURNING *;

-- name: UpsertCommenter :one
-- One row per address (3.2): matched on email_lower; the latest name and address as
-- typed win, and last_seen_at moves (which keeps the maintenance job off it).
INSERT INTO commenters (email, email_lower, display_name)
VALUES (sqlc.arg('email'), sqlc.arg('email_lower'), sqlc.arg('display_name'))
ON CONFLICT (email_lower) DO UPDATE
SET email = EXCLUDED.email,
    display_name = EXCLUDED.display_name,
    last_seen_at = now()
RETURNING *;

-- name: GetCommenter :one
SELECT * FROM commenters WHERE id = $1;

-- name: SetCommenterBlocked :one
-- 5.5: blocking is a flag, undoable. blocked_by is who blocked (16.1, 000066); blocking an
-- address that is already blocked keeps the first block's date and member.
UPDATE commenters
SET blocked_at = CASE WHEN sqlc.arg('blocked')::boolean THEN coalesce(blocked_at, now()) END,
    blocked_by = CASE WHEN sqlc.arg('blocked')::boolean THEN
        CASE WHEN blocked_at IS NULL THEN sqlc.narg('blocked_by')::bigint ELSE blocked_by END
      END
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: CreateCommenterKey :one
-- A browser key (3.3): the SHA-256 of the cookie's value, never the value.
INSERT INTO commenter_keys (key_hash, commenter_id, expires_at)
VALUES ($1, $2, $3)
RETURNING *;

-- name: CreateReaderComment :one
INSERT INTO reader_comments (
  post_id, parent_id, root_id, commenter_id, author_user_id, display_name, body, status,
  held_reason, held_detail, notify_replies, network_hash, confirm_token_hash, approved_at
) VALUES (
  sqlc.arg('post_id'), sqlc.narg('parent_id'), sqlc.narg('root_id'), sqlc.narg('commenter_id'),
  sqlc.narg('author_user_id'), sqlc.arg('display_name'), sqlc.arg('body'), sqlc.arg('status'),
  sqlc.narg('held_reason'), sqlc.narg('held_detail'), sqlc.arg('notify_replies'),
  -- lib/pq sends a nil []byte as an empty bytea, not NULL: NULLIF makes "none" NULL.
  NULLIF(sqlc.narg('network_hash')::bytea, ''::bytea),
  NULLIF(sqlc.narg('confirm_token_hash')::bytea, ''::bytea),
  sqlc.narg('approved_at')
)
RETURNING *;

-- name: GetReaderComment :one
SELECT * FROM reader_comments WHERE id = $1;

-- name: LockReaderComment :one
SELECT * FROM reader_comments WHERE id = $1 FOR UPDATE;

-- name: TrashReaderComment :one
-- Moves a comment to the trash, keeping the status a restore puts back. Its replies are
-- untouched: the thread read renders a trashed root that has approved replies as "This
-- comment was removed" (6.4). An unconfirmed comment isn't moderated (it isn't in the
-- queue yet, 4.1) and expires on its own: no row (it keeps its confirm token, which only
-- an unconfirmed row may hold).
UPDATE reader_comments
SET trashed_from = status,
    status = 'trash',
    moderated_by = sqlc.narg('moderated_by'),
    moderated_at = now()
WHERE id = sqlc.arg('id') AND status NOT IN ('trash', 'unconfirmed') AND removed_at IS NULL
RETURNING *;

-- name: RestoreReaderComment :one
UPDATE reader_comments
SET status = trashed_from,
    trashed_from = NULL,
    moderated_by = sqlc.narg('moderated_by'),
    moderated_at = now()
WHERE id = sqlc.arg('id') AND status = 'trash'
RETURNING *;

-- name: LockReaderCommentReplyStatuses :many
-- The statuses of the rows that answer the comment or sit in the thread it roots, locked:
-- whether deleting it would take approved replies with it (6.4). The lock makes a
-- moderator's approval of one of them wait (or be waited on) instead of racing the
-- delete's cascade; a reply inserted meanwhile waits on the comment's own row lock (its
-- foreign key check).
SELECT status FROM reader_comments
WHERE root_id = sqlc.arg('id')::bigint OR parent_id = sqlc.arg('id')::bigint
ORDER BY id
FOR UPDATE;

-- name: TombstoneReaderComment :one
-- 6.4: a removed comment that still has approved replies keeps its row, emptied: no
-- name, text, commenter, member, network hash or subscription.
UPDATE reader_comments
SET removed_at = now(),
    body = '',
    display_name = '',
    commenter_id = NULL,
    author_user_id = NULL,
    status = 'approved',
    trashed_from = NULL,
    held_reason = NULL,
    held_detail = NULL,
    notify_replies = false,
    network_hash = NULL,
    confirm_token_hash = NULL,
    edited_at = NULL,
    approved_at = coalesce(approved_at, now())
WHERE id = $1
RETURNING *;

-- name: DeleteReaderCommentRow :execrows
-- The row itself; its replies go with it only when it roots their thread (root_id's
-- cascade), which DeleteReaderCommentTx allows only when none of them is approved.
DELETE FROM reader_comments WHERE id = $1;

-- name: DeleteReaderCommentUnsubscribeTokens :exec
DELETE FROM reader_comment_unsubscribe_tokens WHERE comment_id = $1;

-- ---------------------------------------------------------------------------------
-- RunDiscussionMaintenance (api/discussion_maintenance.go, design 6.6). Each statement
-- takes the rows it changes FOR UPDATE SKIP LOCKED, so replicas running it at the same
-- time (and a moderator's transaction) never wait on each other or touch a row twice.
-- The cut-off times come from Go, so the tests can pin them.

-- name: TombstoneExpiredReaderComments :execrows
-- Expired comments that approved replies still hang from become tombstones instead of
-- being deleted: the root's ON DELETE CASCADE would take the replies (6.4).
UPDATE reader_comments c
SET removed_at = now(),
    body = '',
    display_name = '',
    commenter_id = NULL,
    author_user_id = NULL,
    status = 'approved',
    trashed_from = NULL,
    held_reason = NULL,
    held_detail = NULL,
    notify_replies = false,
    network_hash = NULL,
    confirm_token_hash = NULL,
    edited_at = NULL,
    approved_at = coalesce(c.approved_at, now())
WHERE c.id IN (
  SELECT x.id FROM reader_comments x
  WHERE x.removed_at IS NULL
    AND (
      (x.status = 'unconfirmed' AND x.created_at < sqlc.arg('unconfirmed_before')::timestamptz)
      OR (x.status = 'pending' AND x.created_at < sqlc.arg('pending_before')::timestamptz)
      OR (x.status IN ('spam', 'trash') AND coalesce(x.moderated_at, x.created_at) < sqlc.arg('removed_before')::timestamptz)
    )
    AND EXISTS (
      SELECT 1 FROM reader_comments r
      WHERE (r.root_id = x.id OR r.parent_id = x.id) AND r.status = 'approved'
    )
  FOR UPDATE OF x SKIP LOCKED
);

-- name: DeleteTombstoneUnsubscribeTokens :execrows
-- A tombstone's subscription ends with its text, as DeleteReaderCommentTx does for the
-- ones it makes.
DELETE FROM reader_comment_unsubscribe_tokens t
USING reader_comments c
WHERE t.comment_id = c.id AND c.removed_at IS NOT NULL;

-- name: DeleteExpiredReaderComments :execrows
-- Unconfirmed after 48 hours, pending after 90 days, spam and trash 30 days after they
-- got there (moderated_at; created_at for a comment the rules routed to spam).
DELETE FROM reader_comments c
WHERE c.id IN (
  SELECT x.id FROM reader_comments x
  WHERE x.removed_at IS NULL
    AND (
      (x.status = 'unconfirmed' AND x.created_at < sqlc.arg('unconfirmed_before')::timestamptz)
      OR (x.status = 'pending' AND x.created_at < sqlc.arg('pending_before')::timestamptz)
      OR (x.status IN ('spam', 'trash') AND coalesce(x.moderated_at, x.created_at) < sqlc.arg('removed_before')::timestamptz)
    )
    AND NOT EXISTS (
      SELECT 1 FROM reader_comments r
      WHERE (r.root_id = x.id OR r.parent_id = x.id) AND r.status = 'approved'
    )
  FOR UPDATE OF x SKIP LOCKED
);

-- name: DeleteOrphanReaderCommentTombstones :execrows
-- A tombstone exists for its replies; once no row answers it or sits in its thread, it
-- goes. A reply's tombstone going can orphan its root's, so the job runs this until it
-- deletes nothing.
DELETE FROM reader_comments c
WHERE c.id IN (
  SELECT x.id FROM reader_comments x
  WHERE x.removed_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM reader_comments r
      WHERE r.root_id = x.id OR r.parent_id = x.id
    )
  FOR UPDATE OF x SKIP LOCKED
);

-- name: ClearOldReaderCommentNetworkHashes :execrows
-- 7.2: the network hash answers "other comments from this network lately", for 30 days.
UPDATE reader_comments
SET network_hash = NULL
WHERE id IN (
  SELECT x.id FROM reader_comments x
  WHERE x.network_hash IS NOT NULL AND x.created_at < sqlc.arg('before')::timestamptz
  FOR UPDATE OF x SKIP LOCKED
);

-- name: DeleteExpiredCommenterKeys :execrows
DELETE FROM commenter_keys
WHERE key_hash IN (
  SELECT k.key_hash FROM commenter_keys k
  WHERE k.expires_at < sqlc.arg('now')::timestamptz
  FOR UPDATE OF k SKIP LOCKED
);

-- name: DeleteStaleCommenters :execrows
-- A commenter with no comments and no browser keys, unseen since stale_before, goes,
-- unless blocked or marked spam since spam_since: those rows are what the block and
-- previous_spam rules remember (4.2, 5.5), and they hold no text. Their outbox rows go
-- with them (ON DELETE CASCADE).
DELETE FROM commenters c
WHERE c.id IN (
  SELECT x.id FROM commenters x
  WHERE x.last_seen_at < sqlc.arg('stale_before')::timestamptz
    AND x.blocked_at IS NULL
    AND (x.last_spam_at IS NULL OR x.last_spam_at < sqlc.arg('spam_since')::timestamptz)
    AND NOT EXISTS (SELECT 1 FROM reader_comments r WHERE r.commenter_id = x.id)
    AND NOT EXISTS (SELECT 1 FROM commenter_keys k WHERE k.commenter_id = x.id)
  FOR UPDATE OF x SKIP LOCKED
);

-- ---------------------------------------------------------------------------------
-- The public write path (#524, api/discussion_write.go, design 3.3, 4.2, 5, 9.2).

-- name: GetReaderCommentPost :one
-- What the write path reads of the post a comment is for: its state's inputs (12.4) and
-- what its link needs (the published title and category, as the public site shows them).
SELECT p.id, p.post_type, p.slug, p.post_status, p.discussion, p.first_published_at,
  coalesce(p.published_settings->>'title', p.title)::text AS title,
  coalesce(golive_post_category_slug(p.id, true), '')::text AS category_slug
FROM posts p
WHERE p.id = $1;

-- name: GetCommenterByKeys :one
-- 3.3: the commenter one of the browser's keys belongs to, when that is the typed address.
-- A key for another address, an expired one or an unknown one matches nothing, so the
-- answer never says anything about an address.
SELECT c.* FROM commenter_keys k
JOIN commenters c ON c.id = k.commenter_id
WHERE k.key_hash = ANY(sqlc.arg('key_hashes')::bytea[])
  AND k.expires_at > now()
  AND c.email_lower = sqlc.arg('email_lower')
ORDER BY k.created_at DESC
LIMIT 1;

-- name: ListCommenterIDsByKeys :many
-- The commenters the browser's valid keys belong to (the confirm page's Publish and
-- Discard, 3.3 step 5).
SELECT DISTINCT k.commenter_id FROM commenter_keys k
WHERE k.key_hash = ANY(sqlc.arg('key_hashes')::bytea[])
  AND k.expires_at > now();

-- name: EnsureCommenter :one
-- The commenter of a typed address, created when new. An existing row is returned as it
-- is: whoever typed the address hasn't shown they own it, so their name and spelling of
-- the address don't replace the owner's (a confirmation or a key does that).
INSERT INTO commenters (email, email_lower, display_name)
VALUES (sqlc.arg('email'), sqlc.arg('email_lower'), sqlc.arg('display_name'))
ON CONFLICT (email_lower) DO UPDATE SET email_lower = commenters.email_lower
RETURNING *;

-- name: VerifyCommenter :one
-- A confirmation or a key proved the address (3.3): verified, the name used now becomes
-- the commenter's, and last_seen_at moves.
UPDATE commenters
SET verified_at = coalesce(verified_at, now()),
    display_name = sqlc.arg('display_name'),
    last_seen_at = now()
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: CountUnconfirmedReaderComments :one
-- 5.3's cap: unconfirmed comments of an address still waiting (not expired).
SELECT count(*) FROM reader_comments
WHERE commenter_id = sqlc.arg('commenter_id')
  AND status = 'unconfirmed'
  AND created_at > sqlc.arg('created_after')::timestamptz;

-- name: CountPendingReaderCommentsForPost :one
-- 5.3's cap: comments waiting for review on one post.
SELECT count(*) FROM reader_comments
WHERE post_id = $1 AND status = 'pending';

-- name: CommenterHasApprovedReaderComment :one
-- 4.2 first_comment: whether a moderator (or the rules) approved one of theirs before.
SELECT EXISTS (
  SELECT 1 FROM reader_comments WHERE commenter_id = $1 AND status = 'approved'
)::boolean;

-- name: ListMemberNames :many
-- 3.4: a guest name equal to a member's full name or username is held.
SELECT username, full_name FROM users;

-- name: GetUnconfirmedReaderCommentByToken :one
-- 3.3: the comment a confirmation link names, while it waits (48 hours).
SELECT * FROM reader_comments
WHERE confirm_token_hash = sqlc.arg('token_hash')
  AND status = 'unconfirmed'
  AND created_at > sqlc.arg('created_after')::timestamptz;

-- name: GetUnconfirmedReaderCommentForCommenters :one
-- 3.3 step 5: an unconfirmed comment of one of the browser's commenters.
SELECT * FROM reader_comments
WHERE id = sqlc.arg('id')
  AND commenter_id = ANY(sqlc.arg('commenter_ids')::bigint[])
  AND status = 'unconfirmed'
  AND created_at > sqlc.arg('created_after')::timestamptz;

-- name: LockReaderCommentForShare :one
-- A reply's root and parent while it is inserted or published (6.4): the retention job
-- (SKIP LOCKED) and a delete (FOR UPDATE) wait instead of cascading it away.
SELECT * FROM reader_comments WHERE id = $1 FOR SHARE;

-- name: LockUnconfirmedReaderComment :one
SELECT * FROM reader_comments
WHERE id = sqlc.arg('id') AND status = 'unconfirmed'
  AND created_at > sqlc.arg('created_after')::timestamptz
FOR UPDATE;

-- name: PublishUnconfirmedReaderComment :one
-- An unconfirmed comment leaves unconfirmed with what the rules decided (4.2); its
-- confirm token is spent with it.
UPDATE reader_comments
SET status = sqlc.arg('status')::text,
    held_reason = sqlc.narg('held_reason'),
    held_detail = sqlc.narg('held_detail'),
    confirm_token_hash = NULL,
    approved_at = CASE WHEN sqlc.arg('status')::text = 'approved' THEN now() END
WHERE id = sqlc.arg('id') AND status = 'unconfirmed'
RETURNING *;

-- name: ListUnconfirmedReaderCommentsForCommenter :many
-- 3.3 step 5: the address's other unconfirmed comments, for the person holding the link:
-- the post's title and link, and the first 100 characters.
SELECT c.id, c.post_id, c.created_at,
  left(c.body, 100)::text AS excerpt,
  p.post_type, p.slug,
  coalesce(p.published_settings->>'title', p.title)::text AS post_title,
  coalesce(golive_post_category_slug(p.id, true), '')::text AS category_slug
FROM reader_comments c
JOIN posts p ON p.id = c.post_id
WHERE c.commenter_id = sqlc.arg('commenter_id')
  AND c.status = 'unconfirmed'
  AND c.created_at > sqlc.arg('created_after')::timestamptz
  AND c.id <> sqlc.arg('exclude_id')
ORDER BY c.created_at DESC
LIMIT 20;

-- name: DeleteUnconfirmedReaderComment :execrows
-- 3.3 step 5's Discard. An unconfirmed comment has no replies (a reply needs an approved
-- parent), so deleting it takes nothing else.
DELETE FROM reader_comments
WHERE id = sqlc.arg('id')
  AND commenter_id = ANY(sqlc.arg('commenter_ids')::bigint[])
  AND status = 'unconfirmed';
