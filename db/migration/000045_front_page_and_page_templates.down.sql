-- Back to the 000034 snapshot (#336): the template leaves the settings, then the
-- columns go.
BEGIN;

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
    'canonical_url', p.canonical_url,
    'author_ids', coalesce((
      SELECT jsonb_agg(up.user_id ORDER BY up."order", up.user_id)
      FROM user_posts up
      WHERE up.post_id = p.id
    ), '[]'::jsonb)
  )
  FROM posts p
  WHERE p.id = target_post_id
$$;

UPDATE post_versions SET settings = settings - 'page_template' WHERE settings ? 'page_template';
UPDATE post_scheduled_updates SET settings = settings - 'page_template' WHERE settings ? 'page_template';
UPDATE posts SET published_settings = published_settings - 'page_template' WHERE published_settings ? 'page_template';

ALTER TABLE posts DROP COLUMN page_template;
ALTER TABLE settings DROP COLUMN front_page_id;

COMMIT;
