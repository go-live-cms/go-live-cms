-- Reverts 000058. The site's customized templates and parts, their Yjs state and their
-- versions go with the tables; the themes' own templates and code layouts are untouched,
-- so the site renders with each theme's defaults. site_design_releases (000056) stays:
-- it also holds the global styles' versions. The site_template_* activity rows stay: they
-- hold ids and slugs only, and activity is append-only.
ALTER TABLE IF EXISTS "site_templates" DROP CONSTRAINT IF EXISTS "site_templates_published_version_fk";
DROP TABLE IF EXISTS "site_template_versions";
DROP TABLE IF EXISTS "site_template_ydoc_state";
DROP TABLE IF EXISTS "site_templates";
