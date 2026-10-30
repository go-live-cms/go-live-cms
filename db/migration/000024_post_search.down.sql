BEGIN;

DROP TRIGGER IF EXISTS taxonomy_types_search_update ON taxonomy_types;
DROP TRIGGER IF EXISTS taxonomy_terms_search_update ON taxonomy_terms;
DROP TRIGGER IF EXISTS post_terms_search_delete ON post_taxonomy_relationships;
DROP TRIGGER IF EXISTS post_terms_search_insert ON post_taxonomy_relationships;
DROP TRIGGER IF EXISTS posts_search_update ON posts;
DROP TRIGGER IF EXISTS posts_search_insert ON posts;

DROP FUNCTION IF EXISTS golive_term_search_trigger();
DROP FUNCTION IF EXISTS golive_post_terms_search_trigger();
DROP FUNCTION IF EXISTS golive_posts_search_trigger();
DROP FUNCTION IF EXISTS golive_refresh_post_search(bigint[]);

DROP TABLE IF EXISTS post_search;

DROP FUNCTION IF EXISTS golive_block_doc_text(jsonb);
DROP FUNCTION IF EXISTS golive_search_config();

COMMIT;
