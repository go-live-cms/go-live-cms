-- Per-block "Last edited by" (#328, 000049). Written only inside StorePostCollabTx,
-- with a block_doc write; read by GET /posts/:id/block-edits.

-- name: UpsertPostBlockEdits :exec
-- The three arrays are parallel, one entry per changed block (edited_ats as RFC 3339
-- text). A user that no longer exists is stored as NULL rather than failing the store
-- on the foreign key (as post_ydoc_state.last_editor_id).
WITH edits AS (
    SELECT b.block_id, u.user_id, t.edited_at::timestamptz AS edited_at
    FROM unnest(@block_ids::text[]) WITH ORDINALITY AS b(block_id, ord)
    JOIN unnest(@user_ids::bigint[]) WITH ORDINALITY AS u(user_id, ord) ON u.ord = b.ord
    JOIN unnest(@edited_ats::text[]) WITH ORDINALITY AS t(edited_at, ord) ON t.ord = b.ord
)
INSERT INTO post_block_edits (post_id, block_id, user_id, edited_at)
SELECT @post_id, edits.block_id, users.id, edits.edited_at
FROM edits
LEFT JOIN users ON users.id = edits.user_id
ON CONFLICT (post_id, block_id) DO UPDATE
SET user_id = EXCLUDED.user_id,
    edited_at = EXCLUDED.edited_at;

-- name: PrunePostBlockEdits :exec
-- Deletes the rows of blocks that aren't in the post's new block_doc (keep_ids: every
-- key of its "blocks", hidden blocks included).
DELETE FROM post_block_edits
WHERE post_id = @post_id
  AND NOT (block_id = ANY(@keep_ids::text[]));

-- name: ListPostBlockEdits :many
-- A post's rows with the editor's current name (NULL for a member removed since).
SELECT e.block_id, e.edited_at, e.user_id, u.username, u.full_name, u.avatar_url
FROM post_block_edits e
LEFT JOIN users u ON u.id = e.user_id
WHERE e.post_id = $1
ORDER BY e.block_id;
