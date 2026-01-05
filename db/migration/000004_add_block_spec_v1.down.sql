-- Remove Block Spec v1 support (rollback)
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_published_version_fk;

DROP TABLE IF EXISTS post_versions;

ALTER TABLE posts 
  DROP COLUMN IF EXISTS published_block_doc,
  DROP COLUMN IF EXISTS published_version_id,
  DROP COLUMN IF EXISTS block_revision,
  DROP COLUMN IF EXISTS block_doc;