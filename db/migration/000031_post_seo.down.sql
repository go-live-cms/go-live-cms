-- Back to the 000027 settings snapshot, without the SEO fields (#357).
BEGIN;

UPDATE posts
SET published_settings = published_settings - 'seo_title' - 'seo_description' - 'social_image_id' - 'noindex' - 'canonical_url'
WHERE published_settings IS NOT NULL;

UPDATE post_versions
SET settings = settings - 'seo_title' - 'seo_description' - 'social_image_id' - 'noindex' - 'canonical_url'
WHERE settings IS NOT NULL;

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
    ), '[]'::jsonb)
  )
  FROM posts p
  WHERE p.id = target_post_id
$$;

CREATE OR REPLACE FUNCTION golive_post_settings_changed(target_post_id bigint, published jsonb) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT published IS NOT NULL
     AND jsonb_set(published, '{term_ids}', coalesce((
           SELECT jsonb_agg(ppt.taxonomy_term_id ORDER BY ppt.taxonomy_term_id)
           FROM post_published_terms ppt
           WHERE ppt.post_id = target_post_id
         ), '[]'::jsonb)) IS DISTINCT FROM golive_post_settings(target_post_id)
$$;

DROP INDEX idx_posts_social_image_id;

ALTER TABLE posts
  DROP COLUMN canonical_url,
  DROP COLUMN noindex,
  DROP COLUMN social_image_id,
  DROP COLUMN seo_description,
  DROP COLUMN seo_title;

COMMIT;
