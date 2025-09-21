-- Add Block Spec v1 support to posts table
ALTER TABLE posts
  ADD COLUMN block_doc jsonb NOT NULL
    DEFAULT '{"doc_version":1,"blocks_order":[],"blocks":{}}',
  ADD COLUMN block_revision bigint NOT NULL DEFAULT 1,
  ADD COLUMN published_version_id bigint NULL,
  ADD COLUMN published_block_doc jsonb NULL;

-- Create post_versions table for immutable snapshots
CREATE TABLE post_versions (
  id           bigserial PRIMARY KEY,
  post_id      bigint NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  version_no   integer NOT NULL,
  status       text NOT NULL,            -- 'published' (alpha)
  label        text NULL,
  message      text NULL,
  block_doc    jsonb NOT NULL,
  created_by   bigint NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, version_no)
);

-- Index for efficient latest published version lookups
CREATE INDEX post_versions_latest_published_idx
  ON post_versions (post_id, status, version_no DESC);

-- Add foreign key constraint for published_version_id
ALTER TABLE posts
  ADD CONSTRAINT posts_published_version_fk 
  FOREIGN KEY (published_version_id) REFERENCES post_versions(id);