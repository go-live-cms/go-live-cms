-- Per-term lookups on post_taxonomy_relationships (post counts on the admin's
-- Taxonomies screen, posts-by-term) filter on taxonomy_term_id alone, which the
-- unique (post_id, taxonomy_term_id) index can't serve (#167).
CREATE INDEX IF NOT EXISTS "idx_post_taxonomy_relationships_term" ON "post_taxonomy_relationships" ("taxonomy_term_id");
