-- Server-side collaboration state (Hocuspocus migration, #206 / #280).
--
-- One row per post: the full Yjs document (Y.encodeStateAsUpdate) the collab
-- server last stored. It replaces the y-websocket server's LevelDB as the
-- live Yjs store. posts.block_doc stays canonical for everything outside the
-- editor; the collab server writes both in one transaction
-- (StorePostCollabTx).
--
-- block_revision is the posts.block_revision this state produced (or was
-- stored against). When the two differ, something wrote block_doc around the
-- collab server, so the state is stale: the API stops returning it and the
-- server reseeds from block_doc under a new epoch.
--
-- epoch identifies one seeding of the document. A client that last synced
-- another epoch holds structs from a discarded doc and must remount instead
-- of merging them back.
CREATE TABLE "post_ydoc_state" (
  "post_id" bigint PRIMARY KEY REFERENCES "posts" ("id") ON DELETE CASCADE,
  "state" bytea NOT NULL,
  "epoch" uuid NOT NULL,
  "block_revision" bigint NOT NULL,
  -- Who made the edit that triggered the last store (informational).
  "last_editor_id" bigint NULL REFERENCES "users" ("id") ON DELETE SET NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
