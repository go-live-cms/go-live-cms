-- Back to the 000031 snapshot (#319): the byline leaves the settings, and the
-- public site reads user_posts again.
BEGIN;

DROP FUNCTION golive_post_published_byline(bigint);
DROP FUNCTION golive_post_byline(bigint);
DROP TRIGGER posts_published_authors_update ON posts;
DROP TRIGGER posts_published_authors_insert ON posts;
DROP FUNCTION golive_sync_published_authors_trigger();
DROP TABLE post_published_authors;

CREATE OR REPLACE FUNCTION golive_post_settings(target_post_id bigint) RETURNS jsonb
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
    ), '[]'::jsonb),
    'seo_title', p.seo_title,
    'seo_description', p.seo_description,
    'social_image_id', p.social_image_id,
    'noindex', p.noindex,
    'canonical_url', p.canonical_url
  )
  FROM posts p
  WHERE p.id = target_post_id
$$;

UPDATE post_versions SET settings = settings - 'author_ids' WHERE settings ? 'author_ids';
UPDATE posts SET published_settings = published_settings - 'author_ids' WHERE published_settings ? 'author_ids';

DROP INDEX idx_user_posts_user_id;
DROP INDEX idx_user_posts_post_order;

-- The owners credited by the up migration stay: a byline was always meant to exist.

COMMIT;
