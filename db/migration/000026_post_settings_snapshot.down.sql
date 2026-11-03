-- Back to snapshots of the blocks only (#358): the public site reads the live
-- title, excerpt, featured image and terms again. The search functions and
-- trigger go back to their 000024 definitions, then every post is reindexed
-- from the live values.
BEGIN;

DROP TRIGGER post_published_terms_search_delete ON post_published_terms;

CREATE OR REPLACE FUNCTION golive_term_search_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'taxonomy_terms' THEN
    PERFORM golive_refresh_post_search(ARRAY(
      SELECT ptr.post_id FROM post_taxonomy_relationships ptr WHERE ptr.taxonomy_term_id = NEW.id
    ));
  ELSE
    PERFORM golive_refresh_post_search(ARRAY(
      SELECT DISTINCT ptr.post_id
      FROM post_taxonomy_relationships ptr
      JOIN taxonomy_terms tt ON tt.id = ptr.taxonomy_term_id
      WHERE tt.taxonomy_type_id = NEW.id
    ));
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER posts_search_update ON posts;
CREATE TRIGGER posts_search_update
  AFTER UPDATE OF title, description, published_version_id, published_block_doc ON posts
  FOR EACH ROW
  WHEN (OLD.title IS DISTINCT FROM NEW.title
     OR OLD.description IS DISTINCT FROM NEW.description
     OR OLD.published_version_id IS DISTINCT FROM NEW.published_version_id
     OR OLD.published_block_doc IS DISTINCT FROM NEW.published_block_doc)
  EXECUTE FUNCTION golive_posts_search_trigger();

CREATE OR REPLACE FUNCTION golive_refresh_post_search(post_ids bigint[]) RETURNS void
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  PERFORM 1 FROM posts WHERE id = ANY(post_ids) ORDER BY id FOR UPDATE;

  INSERT INTO post_search (post_id, body_text, document)
  SELECT p.id, body.doc_text,
         setweight(to_tsvector(golive_search_config(), p.title), 'A')
      || setweight(to_tsvector(golive_search_config(), p.description), 'B')
      || setweight(to_tsvector(golive_search_config(), coalesce((
           SELECT string_agg(tt.name, ' ' ORDER BY tt.id)
           FROM post_taxonomy_relationships ptr
           JOIN taxonomy_terms tt ON tt.id = ptr.taxonomy_term_id
           JOIN taxonomy_types ty ON ty.id = tt.taxonomy_type_id
           WHERE ptr.post_id = p.id AND ty.public
         ), '')), 'B')
      || setweight(to_tsvector(golive_search_config(), body.doc_text), 'C')
  FROM posts p
  CROSS JOIN LATERAL (
    SELECT golive_block_doc_text(coalesce(
      (SELECT pv.block_doc FROM post_versions pv WHERE pv.id = p.published_version_id),
      p.published_block_doc
    )) AS doc_text
  ) body
  WHERE p.id = ANY(post_ids)
  ON CONFLICT (post_id) DO UPDATE
    SET body_text = EXCLUDED.body_text, document = EXCLUDED.document;
END
$$;

DROP TRIGGER posts_published_terms_update ON posts;
DROP TRIGGER posts_published_terms_insert ON posts;
DROP FUNCTION golive_sync_published_terms_trigger();
DROP TABLE post_published_terms;
DROP FUNCTION golive_public_post_meta(jsonb, jsonb);
DROP FUNCTION golive_post_settings(bigint);

ALTER TABLE posts DROP COLUMN published_settings;
ALTER TABLE post_versions DROP COLUMN settings;

SELECT golive_refresh_post_search(ARRAY(SELECT id FROM posts));

COMMIT;
