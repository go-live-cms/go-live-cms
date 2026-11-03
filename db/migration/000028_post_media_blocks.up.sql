-- How a post uses each linked media (issue #176).
--
-- post_media has one row per post and media. "order" already says whether the
-- row is the featured image (0) or a content link (> 0), but not which blocks
-- show it, and a featured image that is also in the body kept only its
-- featured row (#389), so its block use was lost. blocks lists the post's
-- content blocks that show the media, in document order:
--
--   [{"id": "<block id>", "type": "image"}, ...]
--
-- type is the Block Spec block type, so a future media-bearing block (a theme
-- block, a gallery) records its own. SyncPostContentMedia keeps it current on
-- every collab store, publish and duplicate, for the order-0 row too. A content
-- row (order > 0) with no blocks was linked some other way (POST /posts
-- media_ids, an upload into a post): "attached".
ALTER TABLE "post_media"
  ADD COLUMN "blocks" jsonb NOT NULL DEFAULT '[]';

-- Backfill from the doc the links were last synced from: the published body
-- for a published post (publish syncs them; the collab store doesn't, #135),
-- else the working copy. The same blocks extractMediaIDsFromBlocks reads: the
-- top-level image blocks in blocks_order with a numeric mediaId.
WITH docs AS (
  SELECT p.id AS post_id,
         CASE WHEN p.post_status = 'published' AND p.published_block_doc IS NOT NULL
              THEN p.published_block_doc ELSE p.block_doc END AS doc
  FROM posts p
  WHERE EXISTS (SELECT 1 FROM post_media pm WHERE pm.post_id = p.id)
), uses AS (
  SELECT d.post_id,
         trunc((d.doc -> 'blocks' -> o.block_id -> 'attrs' ->> 'mediaId')::numeric)::bigint AS media_id,
         o.block_id,
         o.ord
  FROM docs d
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(d.doc -> 'blocks_order') = 'array' THEN d.doc -> 'blocks_order' ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS o(block_id, ord)
  WHERE jsonb_typeof(d.doc -> 'blocks') = 'object'
    AND d.doc -> 'blocks' -> o.block_id ->> 'type' = 'image'
    AND jsonb_typeof(d.doc -> 'blocks' -> o.block_id -> 'attrs' -> 'mediaId') = 'number'
), per_media AS (
  SELECT post_id, media_id,
         jsonb_agg(jsonb_build_object('id', block_id, 'type', 'image') ORDER BY ord) AS blocks
  FROM uses
  WHERE media_id > 0
  GROUP BY post_id, media_id
)
UPDATE post_media pm
SET blocks = per_media.blocks
FROM per_media
WHERE pm.post_id = per_media.post_id AND pm.media_id = per_media.media_id;
