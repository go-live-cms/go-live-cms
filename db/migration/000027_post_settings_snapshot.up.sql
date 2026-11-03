-- Publish saves the post's settings, not just its blocks (#358).
--
-- Until now a version (post_versions) held block_doc only, and the public site
-- read the title, excerpt, featured image and terms from the live post row, so
-- on a published post a new title went public the moment it was saved while
-- block edits waited for Update. Now each version also stores the settings the
-- public site shows, and publish copies them into posts.published_settings next
-- to published_block_doc. The public site and its feeds read only those.
--
-- The settings, as golive_post_settings() builds them (version 1):
--   {"title": "...", "description": "...",
--    "featured_image": {"id": 12, "url": "/uploads/media/x.jpg"} | null,
--    "term_ids": [3, 7]}
-- The featured image is the post_meta pair the admin writes (_thumbnail_id,
-- _thumbnail_url); term_ids are sorted, so two snapshots of the same settings
-- are equal jsonb. The SEO fields (#357) and byline authors (#319) join this
-- object later by redefining golive_post_settings(). What stays instant: the
-- slug (it changes at once, with its conflict check), owner, status and trash.
--
-- post_published_terms is the published term set as rows, so the term archives,
-- related posts and the term sitemap can join it like post_taxonomy_relationships.
-- A trigger keeps it equal to published_settings.term_ids: no writer maintains
-- it by hand.
BEGIN;

-- NULL: a version published before #358, whose settings weren't recorded.
ALTER TABLE post_versions ADD COLUMN settings jsonb NULL;
-- NULL: nothing published (a draft, or unpublished).
ALTER TABLE posts ADD COLUMN published_settings jsonb NULL;

-- The working settings of a post, in the snapshot shape above.
CREATE FUNCTION golive_post_settings(target_post_id bigint) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'title', p.title,
    'description', p.description,
    'featured_image', (
      SELECT jsonb_build_object(
        'id', (
          SELECT CASE WHEN tid.meta_value ~ '^[0-9]{1,18}$' THEN tid.meta_value::bigint END
          FROM post_meta tid
          WHERE tid.post_id = p.id AND tid.meta_key = '_thumbnail_id'
        ),
        'url', turl.meta_value
      )
      FROM post_meta turl
      WHERE turl.post_id = p.id AND turl.meta_key = '_thumbnail_url'
        AND coalesce(turl.meta_value, '') <> ''
    ),
    'term_ids', coalesce((
      SELECT jsonb_agg(DISTINCT ptr.taxonomy_term_id ORDER BY ptr.taxonomy_term_id)
      FROM post_taxonomy_relationships ptr
      WHERE ptr.post_id = p.id
    ), '[]'::jsonb)
  )
  FROM posts p
  WHERE p.id = target_post_id
$$;

-- A post's meta as the public site sees it: with published settings, the
-- featured image keys come from the snapshot instead of the live post_meta rows.
CREATE FUNCTION golive_public_post_meta(meta jsonb, settings jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN settings IS NULL THEN meta
    WHEN jsonb_typeof(settings->'featured_image') = 'object' THEN
      (coalesce(meta, '{}'::jsonb) - '_thumbnail_id' - '_thumbnail_url')
        || jsonb_strip_nulls(jsonb_build_object(
             '_thumbnail_id', settings->'featured_image'->>'id',
             '_thumbnail_url', settings->'featured_image'->>'url'))
    ELSE coalesce(meta, '{}'::jsonb) - '_thumbnail_id' - '_thumbnail_url'
  END
$$;

CREATE TABLE post_published_terms (
  post_id bigint NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  taxonomy_term_id bigint NOT NULL REFERENCES taxonomy_terms (id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, taxonomy_term_id)
);
CREATE INDEX idx_post_published_terms_term_id ON post_published_terms (taxonomy_term_id);

-- Rebuild post_published_terms for the post from its published_settings. Ids of
-- terms deleted since the snapshot are skipped.
CREATE FUNCTION golive_sync_published_terms_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM post_published_terms WHERE post_id = NEW.id;
  IF jsonb_typeof(NEW.published_settings->'term_ids') = 'array' THEN
    INSERT INTO post_published_terms (post_id, taxonomy_term_id)
    SELECT NEW.id, tt.id
    FROM taxonomy_terms tt
    WHERE tt.id IN (
      SELECT t.value::bigint
      FROM jsonb_array_elements_text(NEW.published_settings->'term_ids') AS t(value)
      WHERE t.value ~ '^[0-9]{1,18}$'
    );
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER posts_published_terms_insert
  AFTER INSERT ON posts
  FOR EACH ROW WHEN (NEW.published_settings IS NOT NULL)
  EXECUTE FUNCTION golive_sync_published_terms_trigger();

CREATE TRIGGER posts_published_terms_update
  AFTER UPDATE OF published_settings ON posts
  FOR EACH ROW WHEN (OLD.published_settings IS DISTINCT FROM NEW.published_settings)
  EXECUTE FUNCTION golive_sync_published_terms_trigger();

-- Search (#145) indexes what the public site shows: a post with published
-- settings by its published title, excerpt and terms; any other post (a draft)
-- by its working ones, as before. The body was already the published one.
CREATE OR REPLACE FUNCTION golive_refresh_post_search(post_ids bigint[]) RETURNS void
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  PERFORM 1 FROM posts WHERE id = ANY(post_ids) ORDER BY id FOR UPDATE;

  INSERT INTO post_search (post_id, body_text, document)
  SELECT p.id, body.doc_text,
         setweight(to_tsvector(golive_search_config(), coalesce(p.published_settings->>'title', p.title)), 'A')
      || setweight(to_tsvector(golive_search_config(), coalesce(p.published_settings->>'description', p.description)), 'B')
      || setweight(to_tsvector(golive_search_config(), coalesce((
           SELECT string_agg(tt.name, ' ' ORDER BY tt.id)
           FROM taxonomy_terms tt
           JOIN taxonomy_types ty ON ty.id = tt.taxonomy_type_id
           WHERE ty.public AND tt.id IN (
             SELECT t.value::bigint
             FROM jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(p.published_settings->'term_ids') = 'array'
                 THEN p.published_settings->'term_ids' ELSE '[]'::jsonb END
             ) AS t(value)
             WHERE p.published_settings IS NOT NULL AND t.value ~ '^[0-9]{1,18}$'
             UNION ALL
             SELECT ptr.taxonomy_term_id
             FROM post_taxonomy_relationships ptr
             WHERE p.published_settings IS NULL AND ptr.post_id = p.id
           )
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

DROP TRIGGER posts_search_update ON posts;
CREATE TRIGGER posts_search_update
  AFTER UPDATE OF title, description, published_version_id, published_block_doc, published_settings ON posts
  FOR EACH ROW
  WHEN (OLD.title IS DISTINCT FROM NEW.title
     OR OLD.description IS DISTINCT FROM NEW.description
     OR OLD.published_version_id IS DISTINCT FROM NEW.published_version_id
     OR OLD.published_block_doc IS DISTINCT FROM NEW.published_block_doc
     OR OLD.published_settings IS DISTINCT FROM NEW.published_settings)
  EXECUTE FUNCTION golive_posts_search_trigger();

-- A renamed term, or a taxonomy made public or private: the posts that have it
-- in their working or their published terms.
CREATE OR REPLACE FUNCTION golive_term_search_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'taxonomy_terms' THEN
    PERFORM golive_refresh_post_search(ARRAY(
      SELECT ptr.post_id FROM post_taxonomy_relationships ptr WHERE ptr.taxonomy_term_id = NEW.id
      UNION
      SELECT ppt.post_id FROM post_published_terms ppt WHERE ppt.taxonomy_term_id = NEW.id
    ));
  ELSE
    PERFORM golive_refresh_post_search(ARRAY(
      SELECT ptr.post_id
      FROM post_taxonomy_relationships ptr
      JOIN taxonomy_terms tt ON tt.id = ptr.taxonomy_term_id
      WHERE tt.taxonomy_type_id = NEW.id
      UNION
      SELECT ppt.post_id
      FROM post_published_terms ppt
      JOIN taxonomy_terms tt ON tt.id = ppt.taxonomy_term_id
      WHERE tt.taxonomy_type_id = NEW.id
    ));
  END IF;
  RETURN NULL;
END
$$;

-- A deleted term leaves the published term sets (post_published_terms cascades;
-- the ids stay in published_settings, where nothing reads a deleted term).
-- Reindex the posts that published it, now that it's gone. On taxonomy_terms
-- rather than post_published_terms: the sync trigger above deletes those rows on
-- every publish, and posts_search_update already reindexes then.
CREATE FUNCTION golive_deleted_terms_search_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM golive_refresh_post_search(ARRAY(
    SELECT p.id
    FROM posts p
    WHERE jsonb_typeof(p.published_settings->'term_ids') = 'array'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(p.published_settings->'term_ids') AS t(value)
        JOIN deleted_terms d ON d.id::text = t.value
      )
  ));
  RETURN NULL;
END
$$;

CREATE TRIGGER taxonomy_terms_published_search_delete
  AFTER DELETE ON taxonomy_terms
  REFERENCING OLD TABLE AS deleted_terms
  FOR EACH STATEMENT EXECUTE FUNCTION golive_deleted_terms_search_trigger();

-- Backfill: what is public now becomes the published snapshot, so nothing on
-- the site changes on deploy. The current version (the one publish points at)
-- gets the same settings; older versions stay NULL (not recorded). Posts with a
-- public snapshot but no version (seeded, or created as published) are covered
-- by the published_block_doc test.
UPDATE post_versions v
SET settings = golive_post_settings(p.id)
FROM posts p
WHERE p.published_version_id = v.id;

UPDATE posts
SET published_settings = golive_post_settings(id)
WHERE post_status = 'published' OR published_block_doc IS NOT NULL;

COMMIT;
