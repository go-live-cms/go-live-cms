-- Builder page templates (#494, docs/design/theme-builder.md section 10).
--
-- A page may pick a page template made in the Site editor: the active theme's published
-- site template of slug custom-<name> (#490). posts.page_template stores it as
-- block:<name>, next to the theme's own page layouts (#336, 000045). A layout file's name
-- can never hold a ':', so the two forms can't collide.
--
-- The stored name is a reference by name only, never a foreign key: a template that is
-- reset, deleted or belongs to another theme leaves the name in place, the page renders
-- with the default (#336's rule after a theme switch) and picks the template up again
-- once it is published. golive_post_settings() already snapshots page_template, so the
-- choice goes live on Update and versions restore it with no change here.
BEGIN;

ALTER TABLE posts DROP CONSTRAINT posts_page_template_name;
ALTER TABLE posts
  ADD CONSTRAINT posts_page_template_name
    CHECK (page_template ~ '^([A-Za-z0-9_-]{0,64}|block:[a-z0-9-]{1,64})$');

COMMIT;
