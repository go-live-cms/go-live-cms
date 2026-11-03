BEGIN;

DROP FUNCTION golive_post_has_unpublished_changes(bigint, text, text, text, jsonb);
DROP FUNCTION golive_post_settings_changed(bigint, jsonb);

ALTER TABLE posts
  DROP COLUMN block_doc_hash,
  DROP COLUMN published_block_hash;

COMMIT;
