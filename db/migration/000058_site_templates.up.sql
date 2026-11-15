-- Block templates and template parts (#490, docs/design/theme-builder.md 5.1, 5.3, 7).
--
-- One row per (theme, kind, slug) an admin has customized or created. Templates and parts
-- are a second collab document kind on the same collab server, named `template-<id>`
-- (parts share the prefix: they are rows of this table), edited by admins only.
--
-- `block_doc` is the working copy. After "Customize" creates the row (with no Yjs state
-- yet, like POST /posts), only the collab server's store writes it
-- (PUT /internal/site-templates/:id/collab, StoreSiteTemplateCollabTx): rule 11.
-- `block_revision` and site_template_ydoc_state's revision are rule 12's guard, as for
-- posts: a block_doc written around the collab server makes the API withhold the stale
-- state and the server reseeds under a new epoch.
--
-- `theme_slug` has no FK on purpose (5.5): a theme removed from the build keeps its
-- design, and bringing the theme back brings it back.
--
-- The published side (`published_block_doc`, versions under a site_design_releases row)
-- is written by publish (#492); NULL published_block_doc = no override, the theme's
-- default renders.
CREATE TABLE "site_templates" (
  "id"                   bigserial PRIMARY KEY,
  "theme_slug"           varchar NOT NULL CONSTRAINT "site_templates_theme_slug" CHECK ("theme_slug" <> ''),
  "kind"                 varchar NOT NULL CONSTRAINT "site_templates_kind" CHECK ("kind" IN ('template', 'part')),
  -- '_' because post type and taxonomy names allow it (identifierRe): single-case_study.
  -- 80 so custom-<name> fits a 64-character name (design section 10).
  "slug"                 varchar NOT NULL CONSTRAINT "site_templates_slug" CHECK ("slug" ~ '^[a-z0-9][a-z0-9_-]{0,79}$'),
  "title"                varchar(120) NOT NULL CONSTRAINT "site_templates_title" CHECK (btrim("title") <> ''),
  "block_doc"            jsonb   NOT NULL DEFAULT '{}'::jsonb
                         CONSTRAINT "site_templates_block_doc_object" CHECK (jsonb_typeof("block_doc") = 'object'),
  -- 1, as posts.block_revision starts (000004), not the design's 0: the collab server
  -- sends base_revision only when it is positive, and the API requires one on a
  -- state-only store (the seed), so a row at 0 could never store its first state.
  "block_revision"       bigint  NOT NULL DEFAULT 1 CONSTRAINT "site_templates_block_revision" CHECK ("block_revision" >= 1),
  "working_state"        varchar NOT NULL DEFAULT 'custom'
                         CONSTRAINT "site_templates_working_state" CHECK ("working_state" IN ('custom', 'reset')),
  -- Where the working copy started (section 9: "default changed since you customized").
  "source"               varchar NOT NULL CONSTRAINT "site_templates_source" CHECK ("source" IN ('theme', 'starter', 'blank')),
  "source_hash"          varchar NOT NULL DEFAULT '',
  "published_block_doc"  jsonb
                         CONSTRAINT "site_templates_published_block_doc_object"
                         CHECK ("published_block_doc" IS NULL OR jsonb_typeof("published_block_doc") = 'object'),
  "published_version_id" bigint,
  "created_by"           bigint REFERENCES "users" ("id") ON DELETE SET NULL,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "changed_at"           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "site_templates_theme_kind_slug" UNIQUE ("theme_slug", "kind", "slug")
);

-- The collab server's state, as post_ydoc_state is for posts (rule 12): the full Yjs
-- document, the epoch it was seeded under (a UUID, as for posts) and the
-- site_templates.block_revision it was stored against.
CREATE TABLE "site_template_ydoc_state" (
  "template_id"    bigint PRIMARY KEY REFERENCES "site_templates" ("id") ON DELETE CASCADE,
  "state"          bytea  NOT NULL,
  "epoch"          uuid   NOT NULL,
  "block_revision" bigint NOT NULL,
  "last_editor_id" bigint REFERENCES "users" ("id") ON DELETE SET NULL,
  "changed_at"     timestamptz NOT NULL DEFAULT now()
);

-- One row per publish that changed the item, under that publish's release (5.3).
-- block_doc NULL: that release reset it to the theme's default (section 9).
CREATE TABLE "site_template_versions" (
  "id"          bigserial PRIMARY KEY,
  "template_id" bigint NOT NULL REFERENCES "site_templates" ("id") ON DELETE CASCADE,
  "release_id"  bigint NOT NULL REFERENCES "site_design_releases" ("id") ON DELETE CASCADE,
  "version_no"  int    NOT NULL CONSTRAINT "site_template_versions_version_no" CHECK ("version_no" > 0),
  "block_doc"   jsonb
                CONSTRAINT "site_template_versions_block_doc_object"
                CHECK ("block_doc" IS NULL OR jsonb_typeof("block_doc") = 'object'),
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "site_template_versions_template_version" UNIQUE ("template_id", "version_no")
);

CREATE INDEX "idx_site_template_versions_release" ON "site_template_versions" ("release_id");

ALTER TABLE "site_templates"
  ADD CONSTRAINT "site_templates_published_version_fk"
  FOREIGN KEY ("published_version_id") REFERENCES "site_template_versions" ("id") ON DELETE SET NULL;
