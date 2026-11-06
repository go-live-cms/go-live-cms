-- Taxonomies and redirects (#331).
--
-- 1. A taxonomy type may name a default term (taxonomy_types.default_term_id). The
--    category type's is "Uncategorized": a post of type "post" without a category gets
--    it, and it can't be deleted (the foreign key refuses; the API answers 409 first).
-- 2. Categories nest one level: a category deeper than that moves up to its top-level
--    ancestor, and one in a parent loop (or under a term of another taxonomy) becomes
--    top level.
-- 3. One category per post. A post with several keeps one, deterministically: the
--    category it was given first (post_taxonomy_relationships.created_at), then the
--    lowest term id, never the default when it has another. A published post's
--    published set (posts.published_settings.term_ids), a pending scheduled update's
--    snapshot and a template's saved category get the same treatment
--    (golive_keep_one_category: the working copy's kept category when the set has it,
--    else the lowest non-default id), so no published post shows a pending change for
--    it. Versions (post_versions.settings) are history and stay as they were; restoring
--    one keeps one category (AddExistingTermsToPost). A trigger refuses a second
--    category from then on.
-- 4. post_url_structure gains 'category': /{category-slug}/{post-slug} for posts.
-- 5. redirects: one row per old site path. The API writes automatic ones (a post, term
--    or merge changed a public URL) and admins add manual ones; the public site answers
--    a 301/302 for a path that would otherwise be a 404.
--
-- The down migration doesn't bring back the categories removed from posts or the old
-- parents (that information is gone); Uncategorized stays as an ordinary category.
BEGIN;

ALTER TABLE taxonomy_types
  ADD COLUMN default_term_id bigint NULL REFERENCES taxonomy_terms (id);

-- Uncategorized: an existing category with the slug, else a new term (with a free slug:
-- slugs are unique across all taxonomies).
DO $$
DECLARE
  category_type bigint;
  default_term bigint;
  candidate text := 'uncategorized';
  n int := 1;
BEGIN
  SELECT id INTO category_type FROM taxonomy_types WHERE name = 'category';
  IF category_type IS NULL THEN
    RETURN;
  END IF;
  SELECT id INTO default_term FROM taxonomy_terms
  WHERE taxonomy_type_id = category_type AND slug = 'uncategorized';
  IF default_term IS NULL THEN
    WHILE EXISTS (SELECT 1 FROM taxonomy_terms WHERE slug = candidate) LOOP
      n := n + 1;
      candidate := 'uncategorized-' || n;
    END LOOP;
    INSERT INTO taxonomy_terms (name, slug, description, taxonomy_type_id, sort_order)
    VALUES ('Uncategorized', candidate, '', category_type, 0)
    RETURNING id INTO default_term;
  END IF;
  UPDATE taxonomy_terms SET parent_id = NULL WHERE id = default_term;
  UPDATE taxonomy_types SET default_term_id = default_term WHERE id = category_type;
END $$;

-- Categories nest one level.
CREATE TEMP TABLE golive_category_tree AS
WITH RECURSIVE tree AS (
  SELECT t.id, t.id AS root_id, 0 AS depth
  FROM taxonomy_terms t
  JOIN taxonomy_types ty ON ty.id = t.taxonomy_type_id
  WHERE ty.name = 'category' AND t.parent_id IS NULL
  UNION ALL
  SELECT c.id, tree.root_id, tree.depth + 1
  FROM taxonomy_terms c
  JOIN tree ON c.parent_id = tree.id
  JOIN taxonomy_types ty ON ty.id = c.taxonomy_type_id
  WHERE ty.name = 'category'
)
SELECT id, root_id, depth FROM tree;

UPDATE taxonomy_terms t
SET parent_id = tree.root_id
FROM golive_category_tree tree
WHERE t.id = tree.id AND tree.depth >= 2;

UPDATE taxonomy_terms t
SET parent_id = NULL
FROM taxonomy_types ty
WHERE ty.id = t.taxonomy_type_id AND ty.name = 'category'
  AND t.parent_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM golive_category_tree tree WHERE tree.id = t.id);

DROP TABLE golive_category_tree;

-- term_ids (a snapshot's sorted id array) with one category left: preferred when the
-- set has it, else the lowest non-default category, else the default. Other ids (tags,
-- terms deleted since) are kept as they are. Sorted, like golive_post_settings().
CREATE FUNCTION golive_keep_one_category(term_ids jsonb, preferred bigint) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  WITH ids AS (
    SELECT DISTINCT t.value::bigint AS id
    FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(term_ids) = 'array' THEN term_ids ELSE '[]'::jsonb END
    ) AS t(value)
    WHERE t.value ~ '^[0-9]{1,18}$'
  ),
  categories AS (
    SELECT ids.id, (ids.id = ty.default_term_id) IS TRUE AS is_default
    FROM ids
    JOIN taxonomy_terms tt ON tt.id = ids.id
    JOIN taxonomy_types ty ON ty.id = tt.taxonomy_type_id
    WHERE ty.name = 'category'
  ),
  keep AS (
    SELECT id FROM categories
    ORDER BY (id = preferred) IS TRUE DESC, is_default ASC, id ASC
    LIMIT 1
  )
  SELECT coalesce(jsonb_agg(ids.id ORDER BY ids.id), '[]'::jsonb)
  FROM ids
  WHERE ids.id NOT IN (SELECT id FROM categories) OR ids.id IN (SELECT id FROM keep)
$$;

-- The working copies: one category per post.
WITH ranked AS (
  SELECT ptr.post_id, ptr.taxonomy_term_id,
    row_number() OVER (
      PARTITION BY ptr.post_id
      ORDER BY (ptr.taxonomy_term_id = ty.default_term_id) IS TRUE, ptr.created_at, ptr.taxonomy_term_id
    ) AS n
  FROM post_taxonomy_relationships ptr
  JOIN taxonomy_terms tt ON tt.id = ptr.taxonomy_term_id
  JOIN taxonomy_types ty ON ty.id = tt.taxonomy_type_id
  WHERE ty.name = 'category'
)
DELETE FROM post_taxonomy_relationships ptr
USING ranked r
WHERE ptr.post_id = r.post_id AND ptr.taxonomy_term_id = r.taxonomy_term_id AND r.n > 1;

-- Every post of type "post" has a category: the default where it has none (any status).
INSERT INTO post_taxonomy_relationships (post_id, taxonomy_term_id)
SELECT p.id, ty.default_term_id
FROM posts p
JOIN taxonomy_types ty ON ty.name = 'category' AND ty.default_term_id IS NOT NULL
WHERE p.post_type = 'post'
  AND NOT EXISTS (
    SELECT 1 FROM post_taxonomy_relationships ptr
    JOIN taxonomy_terms tt ON tt.id = ptr.taxonomy_term_id
    WHERE ptr.post_id = p.id AND tt.taxonomy_type_id = ty.id
  );

-- The post's working category, the one its snapshots keep when they have it.
CREATE FUNCTION golive_post_category_id(target_post_id bigint) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT ptr.taxonomy_term_id
  FROM post_taxonomy_relationships ptr
  JOIN taxonomy_terms tt ON tt.id = ptr.taxonomy_term_id
  JOIN taxonomy_types ty ON ty.id = tt.taxonomy_type_id
  WHERE ptr.post_id = target_post_id AND ty.name = 'category'
  ORDER BY ptr.taxonomy_term_id
  LIMIT 1
$$;

-- The slug of the category in a post's URL (/:category/:slug): its published category
-- (post_published_terms) for the public site, its working one for the admin. NULL when
-- it has none.
CREATE FUNCTION golive_post_category_slug(target_post_id bigint, published boolean) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT tt.slug
  FROM taxonomy_terms tt
  JOIN taxonomy_types ty ON ty.id = tt.taxonomy_type_id AND ty.name = 'category'
  WHERE tt.id IN (
    SELECT ppt.taxonomy_term_id FROM post_published_terms ppt
    WHERE published AND ppt.post_id = target_post_id
    UNION ALL
    SELECT ptr.taxonomy_term_id FROM post_taxonomy_relationships ptr
    WHERE NOT published AND ptr.post_id = target_post_id
  )
  ORDER BY tt.id
  LIMIT 1
$$;

-- term_ids with the default category added when the set has no category.
CREATE FUNCTION golive_with_default_category(term_ids jsonb) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN ty.default_term_id IS NULL THEN term_ids
    WHEN EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(term_ids) = 'array' THEN term_ids ELSE '[]'::jsonb END
      ) AS t(value)
      JOIN taxonomy_terms tt ON t.value ~ '^[0-9]{1,18}$' AND tt.id = t.value::bigint
      WHERE tt.taxonomy_type_id = ty.id
    ) THEN term_ids
    ELSE (
      SELECT coalesce(jsonb_agg(DISTINCT x.id ORDER BY x.id), '[]'::jsonb)
      FROM (
        SELECT t.value::bigint AS id
        FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(term_ids) = 'array' THEN term_ids ELSE '[]'::jsonb END
        ) AS t(value)
        WHERE t.value ~ '^[0-9]{1,18}$'
        UNION ALL
        SELECT ty.default_term_id
      ) x
    )
  END
  FROM taxonomy_types ty
  WHERE ty.name = 'category'
$$;

-- What the site shows, and what a pending scheduled update would publish.
UPDATE posts p
SET published_settings = jsonb_set(
  p.published_settings, '{term_ids}',
  golive_keep_one_category(p.published_settings->'term_ids', golive_post_category_id(p.id))
)
WHERE p.published_settings IS NOT NULL
  AND golive_keep_one_category(p.published_settings->'term_ids', golive_post_category_id(p.id))
      IS DISTINCT FROM p.published_settings->'term_ids';

UPDATE posts p
SET published_settings = jsonb_set(
  p.published_settings, '{term_ids}', golive_with_default_category(p.published_settings->'term_ids')
)
WHERE p.published_settings IS NOT NULL AND p.post_type = 'post'
  AND golive_with_default_category(p.published_settings->'term_ids')
      IS DISTINCT FROM p.published_settings->'term_ids';

UPDATE post_scheduled_updates su
SET settings = jsonb_set(
  su.settings, '{term_ids}',
  golive_keep_one_category(su.settings->'term_ids', golive_post_category_id(su.post_id))
)
WHERE golive_keep_one_category(su.settings->'term_ids', golive_post_category_id(su.post_id))
      IS DISTINCT FROM su.settings->'term_ids';

UPDATE post_scheduled_updates su
SET settings = jsonb_set(su.settings, '{term_ids}', golive_with_default_category(su.settings->'term_ids'))
FROM posts p
WHERE p.id = su.post_id AND p.post_type = 'post'
  AND golive_with_default_category(su.settings->'term_ids') IS DISTINCT FROM su.settings->'term_ids';

-- A template's saved category: one.
WITH ranked AS (
  SELECT ptt.template_id, ptt.term_id,
    row_number() OVER (
      PARTITION BY ptt.template_id
      ORDER BY (ptt.term_id = ty.default_term_id) IS TRUE, ptt.term_id
    ) AS n
  FROM post_template_terms ptt
  JOIN taxonomy_terms tt ON tt.id = ptt.term_id
  JOIN taxonomy_types ty ON ty.id = tt.taxonomy_type_id
  WHERE ty.name = 'category'
)
DELETE FROM post_template_terms ptt
USING ranked r
WHERE ptt.template_id = r.template_id AND ptt.term_id = r.term_id AND r.n > 1;

-- From now on a second category is refused. The API replaces a post's category in one
-- transaction (delete, then insert); this is the backstop for any other writer. The post
-- row lock serializes two writers of the same post, so both can't pass the check.
CREATE FUNCTION golive_one_category_per_post() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM taxonomy_terms tt
    JOIN taxonomy_types ty ON ty.id = tt.taxonomy_type_id
    WHERE tt.id = NEW.taxonomy_term_id AND ty.name = 'category'
  ) THEN
    PERFORM 1 FROM posts WHERE id = NEW.post_id FOR UPDATE;
    IF EXISTS (
      SELECT 1 FROM post_taxonomy_relationships ptr
      JOIN taxonomy_terms tt ON tt.id = ptr.taxonomy_term_id
      JOIN taxonomy_types ty ON ty.id = tt.taxonomy_type_id
      WHERE ptr.post_id = NEW.post_id AND ty.name = 'category'
        AND ptr.taxonomy_term_id <> NEW.taxonomy_term_id
        -- An UPDATE's own row (its old value) isn't another category.
        AND NOT (TG_OP = 'UPDATE' AND ptr.post_id = OLD.post_id AND ptr.taxonomy_term_id = OLD.taxonomy_term_id)
    ) THEN
      RAISE EXCEPTION 'a post has one category'
        USING ERRCODE = 'unique_violation', CONSTRAINT = 'one_category_per_post';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER post_one_category
BEFORE INSERT OR UPDATE ON post_taxonomy_relationships
FOR EACH ROW EXECUTE PROCEDURE golive_one_category_per_post();

-- Category URLs: /{category-slug}/{post-slug}.
ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_post_url_structure_check;
ALTER TABLE settings
  ADD CONSTRAINT settings_post_url_structure_check
  CHECK (post_url_structure IN ('id', 'slug', 'category'));

-- Redirects. from_path is a site path (no query or fragment, no trailing slash but "/");
-- to_path a site path or an absolute http(s) URL. The API keeps chains collapsed (no
-- row's to_path is another row's from_path) and refuses loops. source: who made it:
-- an admin (manual) or a slug change of a post or term, or a tag merge.
CREATE TABLE redirects (
  id bigserial PRIMARY KEY,
  from_path text NOT NULL
    CONSTRAINT redirects_from_path_format CHECK (from_path ~ '^/' AND char_length(from_path) <= 2000),
  to_path text NOT NULL
    CONSTRAINT redirects_to_path_format CHECK (char_length(to_path) BETWEEN 1 AND 2000 AND to_path <> from_path),
  status_code integer NOT NULL DEFAULT 301
    CONSTRAINT redirects_status_code CHECK (status_code IN (301, 302)),
  source text NOT NULL DEFAULT 'manual'
    CONSTRAINT redirects_source CHECK (source IN ('manual', 'post', 'term', 'merge')),
  created_by bigint NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT redirects_from_path_key UNIQUE (from_path)
);

-- Collapsing chains looks rows up by target.
CREATE INDEX idx_redirects_to_path ON redirects (to_path);
-- Settings › URLs & redirects lists the newest first.
CREATE INDEX idx_redirects_created ON redirects (created_at DESC, id DESC);

COMMIT;
