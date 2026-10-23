-- Collaboration server persistence (#206 / #280). The collab server reaches
-- these through the API's internal listener (GET/PUT /internal/posts/:id/collab);
-- the writes run together in StorePostCollabTx.

-- name: GetPostCollab :one
SELECT
    p.block_doc,
    p.block_revision,
    s.state AS ydoc_state,
    s.epoch AS ydoc_epoch,
    s.block_revision AS ydoc_block_revision
FROM posts p
LEFT JOIN post_ydoc_state s ON s.post_id = p.id
WHERE p.id = $1;

-- name: LockPostForCollabStore :one
SELECT block_revision, post_status
FROM posts
WHERE id = $1
FOR UPDATE;

-- name: UpdatePostBlockDocFromCollab :one
UPDATE posts
SET block_doc = $2,
    block_revision = block_revision + 1
WHERE id = $1
RETURNING block_revision;

-- name: UpsertPostYdocState :exec
-- A last_editor_id that no longer exists is stored as NULL rather than
-- failing the whole store on the foreign key.
INSERT INTO post_ydoc_state (post_id, state, epoch, block_revision, last_editor_id, updated_at)
VALUES (
    @post_id, @state, @epoch, @block_revision,
    (SELECT u.id FROM users u WHERE u.id = sqlc.narg(last_editor_id)::bigint),
    now()
)
ON CONFLICT (post_id) DO UPDATE
SET state = EXCLUDED.state,
    epoch = EXCLUDED.epoch,
    block_revision = EXCLUDED.block_revision,
    last_editor_id = EXCLUDED.last_editor_id,
    updated_at = EXCLUDED.updated_at;

-- name: SyncPostContentMedia :exec
-- Makes the post's content image links (order > 0) match media_ids, in
-- document order, like syncPostMediaAssociations does for PUT /blocks. Ids
-- without a media row are skipped (a stale mediaId must not fail the store),
-- and the featured image link (order 0) is never moved or removed. A repeated
-- id keeps its first position (one row per media, or the upsert would touch
-- the same row twice and fail).
WITH wanted AS (
    SELECT DISTINCT ON (m.id) m.id AS media_id, w.ord::int AS ord
    FROM unnest(@media_ids::bigint[]) WITH ORDINALITY AS w(id, ord)
    JOIN media m ON m.id = w.id
    ORDER BY m.id, w.ord
), removed AS (
    DELETE FROM post_media pm
    WHERE pm.post_id = @post_id
      AND pm."order" > 0
      AND pm.media_id NOT IN (SELECT wanted.media_id FROM wanted)
)
INSERT INTO post_media (post_id, media_id, "order")
SELECT @post_id, wanted.media_id, wanted.ord
FROM wanted
ON CONFLICT (post_id, media_id) DO UPDATE
SET "order" = EXCLUDED."order"
WHERE post_media."order" > 0;
