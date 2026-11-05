-- Post templates (#322): a post's content (and optionally its category and
-- featured image) saved under a name, per post type, to start new posts from.
--
-- Their own table on purpose, not posts with a "template" status. Every read
-- of posts (the admin lists and counts, search and its index triggers, the
-- /public routes, the sitemap and feeds, menus, related/adjacent posts, term
-- and author archives, "Used in", the activity feeds, the scheduler, the
-- collab server) would have to leave a template status out, and each new query
-- would have to remember it. Here none of them can see a template: they read
-- posts. A template has no collab document either; it is a snapshot, and a
-- post made from it is seeded from its block_doc like any new post (#283).
CREATE TABLE "post_templates" (
  "id" bigserial PRIMARY KEY,
  "post_type" varchar NOT NULL REFERENCES "post_types" ("name") ON UPDATE CASCADE ON DELETE CASCADE,
  "name" varchar(120) NOT NULL CHECK (btrim("name") <> ''),
  -- Block Spec v1, checked like a post's (prepareForStore) when it is saved.
  "block_doc" jsonb NOT NULL,
  -- The saved settings (optional): the featured image, and the category terms
  -- in post_template_terms. A deleted image just drops out.
  "featured_media_id" bigint NULL REFERENCES "media" ("id") ON DELETE SET NULL,
  "created_by" bigint NULL REFERENCES "users" ("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "changed_at" timestamptz NOT NULL DEFAULT now()
);

-- One name per post type, whatever its case: the chooser lists them by name.
CREATE UNIQUE INDEX "post_templates_type_name_key" ON "post_templates" ("post_type", lower("name"));

CREATE TABLE "post_template_terms" (
  "template_id" bigint NOT NULL REFERENCES "post_templates" ("id") ON DELETE CASCADE,
  "term_id" bigint NOT NULL REFERENCES "taxonomy_terms" ("id") ON DELETE CASCADE,
  PRIMARY KEY ("template_id", "term_id")
);
