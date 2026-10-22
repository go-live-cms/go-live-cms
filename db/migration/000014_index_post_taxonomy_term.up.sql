-- #131: posts-by-term lookups and term deletes (the unique index leads with post_id).
CREATE INDEX CONCURRENTLY idx_post_taxonomy_term_id ON post_taxonomy_relationships (taxonomy_term_id);
