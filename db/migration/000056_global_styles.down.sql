-- Reverts 000056. The site's style overrides and their history go with the tables; the
-- themes themselves (and their declared tokens) are untouched, so the site renders with
-- each theme's own values. The global_styles_updated and site_design_published activity
-- rows stay: they hold group names and ids only, and activity is append-only.
DROP TABLE IF EXISTS "global_styles";
DROP TABLE IF EXISTS "global_style_versions";
DROP TABLE IF EXISTS "site_design_releases";
