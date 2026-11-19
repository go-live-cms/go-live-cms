-- The public thread reads (#523, C3; docs/design/reader-comments.md 6.2, 6.4, 7.1, 9.1).
--
-- What a reader sees of a post's reader comments: only approved ones. A comment that
-- isn't approved (pending again, spam, trash) or is a tombstone (removed_at) is never
-- shown as itself; it appears as a placeholder ("This comment was removed") only when an
-- approved comment hangs from it, so unapproving or removing a comment never hides its
-- replies (6.4). For those rows the queries blank the name, the text and the member, so
-- no presenter can leak them.
--
-- Never selected: the commenter (id, address), the network hash, tokens, held reasons,
-- the status itself. Nothing here reads the clock (the answers are cached, #185).
--
-- "Shown" = status 'approved' AND removed_at IS NULL. A thread is shown when its root is
-- shown or any comment in it is; a reply is listed when it is shown or a shown comment
-- answers it.

-- name: CountShownReaderComments :one
-- discussion.count (9.1): the comments a reader sees; placeholders and tombstones aren't.
SELECT count(*) FROM reader_comments
WHERE post_id = $1 AND status = 'approved' AND removed_at IS NULL;

-- name: CountPublicReaderCommentThreads :one
SELECT count(*) FROM reader_comments c
WHERE c.post_id = sqlc.arg('post_id') AND c.root_id IS NULL
  AND (
    (c.status = 'approved' AND c.removed_at IS NULL)
    OR EXISTS (
      SELECT 1 FROM reader_comments r
      WHERE r.post_id = c.post_id AND r.root_id = c.id AND r.status = 'approved' AND r.removed_at IS NULL
    )
  );

-- name: ListPublicReaderCommentThreads :many
-- One page of a post's threads (6.2), by their root's created_at.
SELECT
  c.id, c.parent_id, c.root_id, c.created_at,
  (c.status = 'approved' AND c.removed_at IS NULL)::boolean AS shown,
  CASE WHEN c.status = 'approved' AND c.removed_at IS NULL THEN c.display_name ELSE '' END::text AS display_name,
  CASE WHEN c.status = 'approved' AND c.removed_at IS NULL THEN c.body ELSE '' END::text AS body,
  (c.status = 'approved' AND c.removed_at IS NULL AND c.edited_at IS NOT NULL)::boolean AS edited,
  (c.status = 'approved' AND c.removed_at IS NULL AND u.id IS NOT NULL)::boolean AS by_member,
  CASE WHEN c.status = 'approved' AND c.removed_at IS NULL THEN coalesce(nullif(btrim(u.full_name), ''), u.username, '') ELSE '' END::text AS member_name,
  CASE WHEN c.status = 'approved' AND c.removed_at IS NULL THEN coalesce(u.avatar_url, '') ELSE '' END::text AS member_avatar,
  (c.status = 'approved' AND c.removed_at IS NULL AND EXISTS (
    SELECT 1 FROM post_published_authors pa WHERE pa.post_id = c.post_id AND pa.user_id = c.author_user_id
  ))::boolean AS member_is_author
FROM reader_comments c
LEFT JOIN users u ON u.id = c.author_user_id
WHERE c.post_id = sqlc.arg('post_id') AND c.root_id IS NULL
  AND (
    (c.status = 'approved' AND c.removed_at IS NULL)
    OR EXISTS (
      SELECT 1 FROM reader_comments r
      WHERE r.post_id = c.post_id AND r.root_id = c.id AND r.status = 'approved' AND r.removed_at IS NULL
    )
  )
ORDER BY
  CASE WHEN sqlc.arg('newest_first')::boolean THEN c.created_at END DESC,
  CASE WHEN sqlc.arg('newest_first')::boolean THEN c.id END DESC,
  c.created_at ASC,
  c.id ASC
LIMIT sqlc.arg('limit_count')::int OFFSET sqlc.arg('offset_count')::int;

-- name: GetPublicReaderCommentThread :one
-- One thread's root (?thread=, 6.2), when it is a shown thread of this post.
SELECT
  c.id, c.parent_id, c.root_id, c.created_at,
  (c.status = 'approved' AND c.removed_at IS NULL)::boolean AS shown,
  CASE WHEN c.status = 'approved' AND c.removed_at IS NULL THEN c.display_name ELSE '' END::text AS display_name,
  CASE WHEN c.status = 'approved' AND c.removed_at IS NULL THEN c.body ELSE '' END::text AS body,
  (c.status = 'approved' AND c.removed_at IS NULL AND c.edited_at IS NOT NULL)::boolean AS edited,
  (c.status = 'approved' AND c.removed_at IS NULL AND u.id IS NOT NULL)::boolean AS by_member,
  CASE WHEN c.status = 'approved' AND c.removed_at IS NULL THEN coalesce(nullif(btrim(u.full_name), ''), u.username, '') ELSE '' END::text AS member_name,
  CASE WHEN c.status = 'approved' AND c.removed_at IS NULL THEN coalesce(u.avatar_url, '') ELSE '' END::text AS member_avatar,
  (c.status = 'approved' AND c.removed_at IS NULL AND EXISTS (
    SELECT 1 FROM post_published_authors pa WHERE pa.post_id = c.post_id AND pa.user_id = c.author_user_id
  ))::boolean AS member_is_author
FROM reader_comments c
LEFT JOIN users u ON u.id = c.author_user_id
WHERE c.id = sqlc.arg('id') AND c.post_id = sqlc.arg('post_id') AND c.root_id IS NULL
  AND (
    (c.status = 'approved' AND c.removed_at IS NULL)
    OR EXISTS (
      SELECT 1 FROM reader_comments r
      WHERE r.post_id = c.post_id AND r.root_id = c.id AND r.status = 'approved' AND r.removed_at IS NULL
    )
  );

-- name: ListPublicReaderCommentReplies :many
-- The listed replies of the given threads, oldest first, at most per_thread of each, with
-- how many each thread lists in all (6.2: a thread over 100 shows the first 100 and "Show
-- more replies").
WITH listed AS (
  SELECT
    c.id, c.parent_id, c.root_id, c.created_at,
    (c.status = 'approved' AND c.removed_at IS NULL)::boolean AS shown,
    CASE WHEN c.status = 'approved' AND c.removed_at IS NULL THEN c.display_name ELSE '' END::text AS display_name,
    CASE WHEN c.status = 'approved' AND c.removed_at IS NULL THEN c.body ELSE '' END::text AS body,
    (c.status = 'approved' AND c.removed_at IS NULL AND c.edited_at IS NOT NULL)::boolean AS edited,
    (c.status = 'approved' AND c.removed_at IS NULL AND u.id IS NOT NULL)::boolean AS by_member,
    CASE WHEN c.status = 'approved' AND c.removed_at IS NULL THEN coalesce(nullif(btrim(u.full_name), ''), u.username, '') ELSE '' END::text AS member_name,
    CASE WHEN c.status = 'approved' AND c.removed_at IS NULL THEN coalesce(u.avatar_url, '') ELSE '' END::text AS member_avatar,
    (c.status = 'approved' AND c.removed_at IS NULL AND EXISTS (
      SELECT 1 FROM post_published_authors pa WHERE pa.post_id = c.post_id AND pa.user_id = c.author_user_id
    ))::boolean AS member_is_author,
    row_number() OVER (PARTITION BY c.root_id ORDER BY c.created_at, c.id) AS position,
    count(*) OVER (PARTITION BY c.root_id) AS thread_reply_count
  FROM reader_comments c
  LEFT JOIN users u ON u.id = c.author_user_id
  WHERE c.post_id = sqlc.arg('post_id') AND c.root_id = ANY(sqlc.arg('root_ids')::bigint[])
    AND (
      (c.status = 'approved' AND c.removed_at IS NULL)
      OR EXISTS (
        SELECT 1 FROM reader_comments ch
        WHERE ch.post_id = c.post_id AND ch.parent_id = c.id AND ch.status = 'approved' AND ch.removed_at IS NULL
      )
    )
)
SELECT
  listed.id, listed.parent_id, listed.root_id, listed.created_at, listed.shown, listed.display_name,
  listed.body, listed.edited, listed.by_member, listed.member_name, listed.member_avatar,
  listed.member_is_author, listed.thread_reply_count
FROM listed
WHERE listed.position <= sqlc.arg('per_thread')::bigint
ORDER BY listed.root_id, listed.position;

-- name: ListPublicReaderCommentsFlat :many
-- Flat threading (comments_threading = flat, 6.2 A): every shown comment, replies
-- included, each on its own, by created_at. No placeholders: nothing hides behind
-- another comment.
SELECT
  c.id, c.parent_id, c.root_id, c.created_at,
  true::boolean AS shown,
  c.display_name::text AS display_name,
  c.body::text AS body,
  (c.edited_at IS NOT NULL)::boolean AS edited,
  (u.id IS NOT NULL)::boolean AS by_member,
  coalesce(nullif(btrim(u.full_name), ''), u.username, '')::text AS member_name,
  coalesce(u.avatar_url, '')::text AS member_avatar,
  EXISTS (
    SELECT 1 FROM post_published_authors pa WHERE pa.post_id = c.post_id AND pa.user_id = c.author_user_id
  )::boolean AS member_is_author
FROM reader_comments c
LEFT JOIN users u ON u.id = c.author_user_id
WHERE c.post_id = sqlc.arg('post_id') AND c.status = 'approved' AND c.removed_at IS NULL
ORDER BY
  CASE WHEN sqlc.arg('newest_first')::boolean THEN c.created_at END DESC,
  CASE WHEN sqlc.arg('newest_first')::boolean THEN c.id END DESC,
  c.created_at ASC,
  c.id ASC
LIMIT sqlc.arg('limit_count')::int OFFSET sqlc.arg('offset_count')::int;
