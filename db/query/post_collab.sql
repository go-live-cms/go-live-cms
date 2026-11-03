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
-- changed_at is the post's "last modified" (admin list and sort, sitemap
-- lastmod). Only stores that carry a block_doc reach this query, and the
-- collab server sends one only when the derived doc changed, so state-only
-- stores (the seed, unchanged or invalid docs) leave it alone (#307).
UPDATE posts
SET block_doc = $2,
    block_revision = block_revision + 1,
    changed_at = now()
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
-- Makes the post's content image links (order > 0) match the doc's media
-- blocks, in document order (the collab store, publish and duplicate). The
-- three arrays are parallel, one entry per block: media_ids[i] is shown by
-- block block_ids[i] of type block_types[i]. Ids without a media row are
-- skipped (a stale mediaId must not fail the store). One row per media: its
-- order is the media's first position among the doc's distinct media ids (1,
-- 2, ..., a skipped id keeping its slot) and its blocks every block showing it
-- (#176). The featured image link
-- (order 0) is never moved or removed, even when the featured image is also in
-- the content (#389); only its blocks follow the doc.
WITH uses AS (
    SELECT u.media_id, b.block_id, t.block_type, u.ord
    FROM unnest(@media_ids::bigint[]) WITH ORDINALITY AS u(media_id, ord)
    JOIN unnest(@block_ids::text[]) WITH ORDINALITY AS b(block_id, ord) ON b.ord = u.ord
    JOIN unnest(@block_types::text[]) WITH ORDINALITY AS t(block_type, ord) ON t.ord = u.ord
), per_media AS (
    SELECT uses.media_id,
           (ROW_NUMBER() OVER (ORDER BY MIN(uses.ord)))::int AS ord,
           jsonb_agg(jsonb_build_object('id', uses.block_id, 'type', uses.block_type) ORDER BY uses.ord) AS blocks
    FROM uses
    GROUP BY uses.media_id
), wanted AS (
    -- Ranked before the media join, so a missing id keeps its slot.
    SELECT per_media.media_id, per_media.ord, per_media.blocks
    FROM per_media
    JOIN media m ON m.id = per_media.media_id
), removed AS (
    DELETE FROM post_media pm
    WHERE pm.post_id = @post_id
      AND pm."order" > 0
      AND pm.media_id NOT IN (SELECT wanted.media_id FROM wanted)
), cleared AS (
    UPDATE post_media pm
    SET blocks = '[]'::jsonb
    WHERE pm.post_id = @post_id
      AND pm."order" = 0
      AND pm.blocks <> '[]'::jsonb
      AND pm.media_id NOT IN (SELECT wanted.media_id FROM wanted)
)
INSERT INTO post_media (post_id, media_id, "order", blocks)
SELECT @post_id, wanted.media_id, wanted.ord, wanted.blocks
FROM wanted
ON CONFLICT (post_id, media_id) DO UPDATE
SET "order" = CASE WHEN post_media."order" = 0 THEN 0 ELSE EXCLUDED."order" END,
    blocks = EXCLUDED.blocks
-- Unchanged rows are left alone: the collab store runs this every few seconds.
WHERE post_media.blocks IS DISTINCT FROM EXCLUDED.blocks
   OR (post_media."order" > 0 AND post_media."order" IS DISTINCT FROM EXCLUDED."order");
