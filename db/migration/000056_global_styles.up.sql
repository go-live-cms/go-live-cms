-- Global styles (#485, docs/design/theme-builder.md 5.1 and section 6).
--
-- A site's override of the active theme's declared tokens, one row per theme (16.6: per
-- theme, so switching back brings a theme's design back). `draft` is what the styles
-- screen saves (PUT /site-design/global-styles, optimistic on `draft_revision`);
-- `published` is what the site shows (served with GET /themes/active). Both are the
-- partial ThemeConfig shape of design 6.2, validated by the API (api/global_styles.go)
-- on every write and again on publish, so nothing free-form reaches the page's <style>.
--
-- The draft is never in theme_settings or extension_settings: those are public.
--
-- `theme_slug` has no FK on purpose (5.5): a theme removed from the build keeps its
-- design, and bringing the theme back brings it back.
--
-- site_design_releases is one row per publish of the site design (design 8.2). It covers
-- global styles only for now; templates and parts (#490, #492) add their versions under
-- the same release. `summary` holds token group names and counts, never values.
CREATE TABLE "site_design_releases" (
  "id"           bigserial PRIMARY KEY,
  "theme_slug"   varchar NOT NULL CONSTRAINT "site_design_releases_theme_slug" CHECK ("theme_slug" <> ''),
  "published_by" bigint REFERENCES "users" ("id") ON DELETE SET NULL,
  "published_at" timestamptz NOT NULL DEFAULT now(),
  "summary"      jsonb NOT NULL DEFAULT '{}'::jsonb
                 CONSTRAINT "site_design_releases_summary_object" CHECK (jsonb_typeof("summary") = 'object')
);

CREATE INDEX "idx_site_design_releases_theme" ON "site_design_releases" ("theme_slug", "published_at" DESC);

CREATE TABLE "global_styles" (
  "theme_slug"           varchar PRIMARY KEY CONSTRAINT "global_styles_theme_slug" CHECK ("theme_slug" <> ''),
  "draft"                jsonb  NOT NULL DEFAULT '{}'::jsonb
                         CONSTRAINT "global_styles_draft_object" CHECK (jsonb_typeof("draft") = 'object'),
  "draft_revision"       bigint NOT NULL DEFAULT 0 CONSTRAINT "global_styles_draft_revision" CHECK ("draft_revision" >= 0),
  "published"            jsonb  NOT NULL DEFAULT '{}'::jsonb
                         CONSTRAINT "global_styles_published_object" CHECK (jsonb_typeof("published") = 'object'),
  "published_version_id" bigint,
  "changed_by"           bigint REFERENCES "users" ("id") ON DELETE SET NULL,
  "changed_at"           timestamptz NOT NULL DEFAULT now()
);

-- One row per publish that changed a theme's styles, under its release (design 5.3).
-- Restoring one puts `styles` back into the draft; it reaches the site on the next publish.
CREATE TABLE "global_style_versions" (
  "id"         bigserial PRIMARY KEY,
  "theme_slug" varchar NOT NULL,
  "release_id" bigint  NOT NULL REFERENCES "site_design_releases" ("id") ON DELETE CASCADE,
  "version_no" int     NOT NULL CONSTRAINT "global_style_versions_version_no" CHECK ("version_no" > 0),
  "styles"     jsonb   NOT NULL CONSTRAINT "global_style_versions_styles_object" CHECK (jsonb_typeof("styles") = 'object'),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("theme_slug", "version_no")
);

CREATE INDEX "idx_global_style_versions_release" ON "global_style_versions" ("release_id");

ALTER TABLE "global_styles"
  ADD CONSTRAINT "global_styles_published_version_fk"
  FOREIGN KEY ("published_version_id") REFERENCES "global_style_versions" ("id") ON DELETE SET NULL;
