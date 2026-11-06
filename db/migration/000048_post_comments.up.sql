-- Block comments (#192; design: docs/design/block-map-yjs-schema.md, "#192: block
-- comments", Option C of #315). A thread is anchored to one block of the post's
-- working copy by the block's data-block-id. Nothing is stored in the Yjs document,
-- block_doc or a version: threads survive reseeds, restores and restarts because
-- they live here, and a thread whose block is gone (deleted, joined, cut and
-- pasted, or left out by a restore) is an orphan the editor lists apart. It
-- reattaches if a later restore brings the block back: nothing deletes it.
--
-- Comments are plain text, edited only by their author. Deleting one keeps the row
-- (deleted_at, body emptied) so replies keep their place; deleting a thread's last
-- live comment deletes the thread (the API does that in one transaction).
--
-- User FKs are SET NULL: a removed member's comments stay, without a name. The
-- post's deletion takes its threads and comments with it. Comments never reach the
-- public site: only /api/v1/posts/:id/comment* reads them, behind a content role.
CREATE TABLE "post_comment_threads" (
  "id" bigserial PRIMARY KEY,
  "post_id" bigint NOT NULL REFERENCES "posts" ("id") ON DELETE CASCADE,
  -- The anchor: the block's data-block-id (the identity contract in the design).
  "block_id" text NOT NULL
    CONSTRAINT "post_comment_threads_block_id" CHECK ("block_id" ~ '^[!-~]{10,128}$'),
  "created_by" bigint NULL REFERENCES "users" ("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "resolved_at" timestamptz NULL,
  "resolved_by" bigint NULL REFERENCES "users" ("id") ON DELETE SET NULL,
  CONSTRAINT "post_comment_threads_resolved_by" CHECK ("resolved_by" IS NULL OR "resolved_at" IS NOT NULL)
);

-- A post's threads (the editor's list), by block.
CREATE INDEX "idx_post_comment_threads_post" ON "post_comment_threads" ("post_id", "block_id");

CREATE TABLE "post_comments" (
  "id" bigserial PRIMARY KEY,
  "thread_id" bigint NOT NULL REFERENCES "post_comment_threads" ("id") ON DELETE CASCADE,
  "author_id" bigint NULL REFERENCES "users" ("id") ON DELETE SET NULL,
  -- Plain text, rendered as text. Emptied when the comment is deleted.
  "body" text NOT NULL
    CONSTRAINT "post_comments_body_length" CHECK (char_length("body") <= 4000),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "edited_at" timestamptz NULL,
  "deleted_at" timestamptz NULL,
  CONSTRAINT "post_comments_body" CHECK (("deleted_at" IS NULL AND "body" ~ '\S') OR ("deleted_at" IS NOT NULL AND "body" = ''))
);

-- A thread's comments in order, and the cascade.
CREATE INDEX "idx_post_comments_thread" ON "post_comments" ("thread_id", "created_at", "id");
