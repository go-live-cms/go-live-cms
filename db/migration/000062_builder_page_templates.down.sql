-- Back to 000045's page template names (#494): a page on a builder template goes back to
-- the theme's default, in the working copy and in every snapshot, so the old CHECK holds
-- and no published page shows a pending change it didn't have.
BEGIN;

UPDATE posts SET page_template = '' WHERE page_template LIKE 'block:%';

UPDATE posts
SET published_settings = published_settings || '{"page_template": ""}'::jsonb
WHERE published_settings ->> 'page_template' LIKE 'block:%';

UPDATE post_versions
SET settings = settings || '{"page_template": ""}'::jsonb
WHERE settings ->> 'page_template' LIKE 'block:%';

UPDATE post_scheduled_updates
SET settings = settings || '{"page_template": ""}'::jsonb
WHERE settings ->> 'page_template' LIKE 'block:%';

ALTER TABLE posts DROP CONSTRAINT posts_page_template_name;
ALTER TABLE posts
  ADD CONSTRAINT posts_page_template_name CHECK (page_template ~ '^[A-Za-z0-9_-]{0,64}$');

COMMIT;
