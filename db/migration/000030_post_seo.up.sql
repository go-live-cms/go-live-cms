-- A post's SEO settings (#357): typed columns, not post_meta keys.
--
-- seo_title and seo_description override the post title and excerpt in search
-- results ('' = use them), social_image_id the featured image in shared links
-- (NULL = use it), noindex hides the post from search engines (robots meta, not
-- in the sitemap; it stays in RSS, archives and site search) and canonical_url
-- names the original address ('' = the post's own; an absolute http(s) URL,
-- checked by the API).
--
-- They follow the publish rule of the other settings (#358): golive_post_settings()
-- now snapshots them, so on a published post an SEO edit reaches the site on
-- Update, every version records them and restoring a version brings them back.
BEGIN;

ALTER TABLE posts
  ADD COLUMN seo_title text NOT NULL DEFAULT '',
  ADD COLUMN seo_description text NOT NULL DEFAULT '',
  ADD COLUMN social_image_id bigint NULL REFERENCES media (id) ON DELETE SET NULL,
  ADD COLUMN noindex boolean NOT NULL DEFAULT false,
  ADD COLUMN canonical_url text NOT NULL DEFAULT '';

-- Deleting a media row sets the column to NULL: without an index that is a scan
-- of posts per deleted media.
CREATE INDEX idx_posts_social_image_id ON posts (social_image_id) WHERE social_image_id IS NOT NULL;

-- The 000027 snapshot plus the SEO fields:
--   {..., "seo_title": "", "seo_description": "", "social_image_id": 12 | null,
--    "noindex": false, "canonical_url": ""}
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

-- Snapshots taken before this get the defaults, which is what they published (no
-- SEO fields existed), so a published post doesn't show a pending change and
-- restoring an older version clears the SEO fields as it should.
UPDATE post_versions
SET settings = '{"seo_title": "", "seo_description": "", "social_image_id": null, "noindex": false, "canonical_url": ""}'::jsonb || settings
WHERE settings IS NOT NULL;

UPDATE posts
SET published_settings = '{"seo_title": "", "seo_description": "", "social_image_id": null, "noindex": false, "canonical_url": ""}'::jsonb || published_settings
WHERE published_settings IS NOT NULL;

COMMIT;
