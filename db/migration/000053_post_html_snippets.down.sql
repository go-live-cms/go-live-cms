BEGIN;

CREATE OR REPLACE FUNCTION golive_post_has_unpublished_changes(
  target_post_id bigint, status text, block_hash text, published_hash text, published jsonb
) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN status IS DISTINCT FROM 'published' THEN false
    WHEN block_hash IS DISTINCT FROM published_hash THEN true
    ELSE golive_post_settings_changed(target_post_id, published)
  END
$$;

DROP FUNCTION golive_post_html_snippets_changed(bigint);

ALTER TABLE posts DROP COLUMN published_block_hash;
ALTER TABLE posts
  ADD COLUMN published_block_hash text GENERATED ALWAYS AS (md5(published_block_doc::text)) STORED;

DROP FUNCTION golive_block_doc_without_html_markup(jsonb);

DROP TABLE post_html_snippets;

COMMIT;
