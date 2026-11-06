-- Back to before #331. Categories removed from posts and the old parents aren't
-- restored (000047 didn't keep them); Uncategorized stays as an ordinary category.
BEGIN;

DROP TABLE redirects;

UPDATE settings SET post_url_structure = 'slug' WHERE post_url_structure = 'category';
ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_post_url_structure_check;
ALTER TABLE settings
  ADD CONSTRAINT settings_post_url_structure_check CHECK (post_url_structure IN ('id', 'slug'));

DROP TRIGGER post_one_category ON post_taxonomy_relationships;
DROP FUNCTION golive_one_category_per_post();
DROP FUNCTION golive_with_default_category(jsonb);
DROP FUNCTION golive_post_category_id(bigint);
DROP FUNCTION golive_post_category_slug(bigint, boolean);
DROP FUNCTION golive_keep_one_category(jsonb, bigint);

ALTER TABLE taxonomy_types DROP COLUMN default_term_id;

COMMIT;
