-- Per-block "Last edited by" (#328; design: docs/design/block-map-yjs-schema.md, "#328:
-- per-block 'Last edited by'", Option C of #315). One row per block of a post's working
-- copy: who last changed the block's content, and when.
--
-- Only the collab server's store writes it (PUT /internal/posts/:id/collab, in the same
-- StorePostCollabTx as the block_doc write it belongs to), so a client can't forge it,
-- and it changes only when a block's content does: a state-only store writes nothing
-- here. Rows of blocks that are no longer in block_doc are deleted by that same store.
--
-- Nothing is kept in the Yjs document, block_doc or a version, so attribution survives
-- reseeds, restores and restarts, and never reaches the public site: only
-- GET /api/v1/posts/:id/block-edits reads it, behind a content role and canReadPost.
--
-- user_id is SET NULL: a removed member's blocks keep their time, without a name.
CREATE TABLE "post_block_edits" (
  "post_id" bigint NOT NULL REFERENCES "posts" ("id") ON DELETE CASCADE,
  -- The block's data-block-id, a key of the post's block_doc "blocks".
  "block_id" text NOT NULL
    CONSTRAINT "post_block_edits_block_id" CHECK (char_length("block_id") BETWEEN 1 AND 128),
  "user_id" bigint NULL REFERENCES "users" ("id") ON DELETE SET NULL,
  "edited_at" timestamptz NOT NULL,
  PRIMARY KEY ("post_id", "block_id")
);

-- The SET NULL when a member is removed.
CREATE INDEX "idx_post_block_edits_user" ON "post_block_edits" ("user_id");
