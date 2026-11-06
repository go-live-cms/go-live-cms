-- The front page and page templates (#336).
--
-- settings.front_page_id names the page the public site renders at / (NULL = the
-- latest posts, as before). The API only accepts a published page; when that page is
-- later unpublished, archived or moved to the trash the id stays, and / shows the
-- latest posts until it is published again (GET /public/front-page answers 404). A
-- permanent delete clears it (ON DELETE SET NULL).
--
-- posts.page_template is the page's layout in the active theme
-- (themes/<slug>/layouts/page/<name>.astro; '' = the theme's default for pages). It
-- is a post setting (#358): golive_post_settings() now snapshots it, so on a
-- published page a template change reaches the site on Update, every version records
-- it and restoring a version brings it back. A name the active theme doesn't have
-- (after a theme switch) is kept and rendered with the default layout.
BEGIN;

ALTER TABLE settings
  ADD COLUMN front_page_id bigint NULL REFERENCES posts (id) ON DELETE SET NULL;

ALTER TABLE posts
  ADD COLUMN page_template text NOT NULL DEFAULT ''
    CONSTRAINT posts_page_template_name CHECK (page_template ~ '^[A-Za-z0-9_-]{0,64}$');

-- The 000034 snapshot plus the template:
--   {..., "page_template": "fullwidth"}
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
    ), '[]'::jsonb),
    'page_template', p.page_template
  )
  FROM posts p
  WHERE p.id = target_post_id
$$;

-- Snapshots taken before this get the default, which is what they published (every
-- page used its type's layout), so no published post shows a pending change and a
-- scheduled update (#335) doesn't publish one.
UPDATE post_versions
SET settings = settings || '{"page_template": ""}'::jsonb
WHERE settings IS NOT NULL AND NOT settings ? 'page_template';

UPDATE post_scheduled_updates
SET settings = settings || '{"page_template": ""}'::jsonb
WHERE NOT settings ? 'page_template';

UPDATE posts
SET published_settings = published_settings || '{"page_template": ""}'::jsonb
WHERE published_settings IS NOT NULL AND NOT published_settings ? 'page_template';

COMMIT;
