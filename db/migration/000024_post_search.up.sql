-- Full-text search (#145).
--
-- One post_search row per post: `document` is the tsvector the search queries
-- match and rank (title A, description B, term names B, published body C) and
-- `body_text` the published body as plain text, for ts_headline's excerpts. It
-- is its own table so the many `RETURNING *` / `SELECT *` queries on posts
-- never read it.
--
-- The body is the published snapshot only, never the working copy (block_doc,
-- which the collab server writes while people type): the post_versions row
-- publish points published_version_id at, else published_block_doc (seeded
-- posts and posts created as published have a snapshot but no version row).
-- Unpublishing clears both, so a draft's document holds no body.
--
-- The triggers below keep it current: publish and unpublish (they write
-- published_version_id / published_block_doc), title and description edits,
-- term links added or removed, a term renamed, a taxonomy made public or not.
-- Hooking the columns rather than each handler covers every writer: the API's
-- transactions, the seeders and anything later.
BEGIN;

-- The text search configuration. 'simple' (no stemming, no stop words) until
-- the site language setting (#330) exists; that issue redefines this function
-- and reindexes with SELECT golive_refresh_post_search(ARRAY(SELECT id FROM posts)).
CREATE FUNCTION golive_search_config() RETURNS regconfig
LANGUAGE sql STABLE AS $$
  SELECT 'simple'::regconfig
$$;

-- The plain text of a Block Spec document in reading order: blocks_order, each
-- block followed by its children (list items, nested lists), one line per text
-- part. Reads what blockBridge stores: attrs.text (every text block's
-- textContent), attrs.code (code blocks), an image's caption runs and a quote's
-- cite. Anything malformed is skipped, never an error; nesting is cut at 8
-- levels so a cycle can't recurse forever.
CREATE FUNCTION golive_block_doc_text(doc jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  WITH RECURSIVE walk(block_id, path) AS (
    SELECT o.block_id, ARRAY[o.ord]
    FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(doc->'blocks_order') = 'array' THEN doc->'blocks_order' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS o(block_id, ord)
    UNION ALL
    SELECT c.block_id, w.path || c.ord
    FROM walk w
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(doc->'blocks'->w.block_id->'children') = 'array'
        THEN doc->'blocks'->w.block_id->'children' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS c(block_id, ord)
    WHERE cardinality(w.path) < 8
  )
  SELECT coalesce(string_agg(part.value, E'\n' ORDER BY w.path, part.n), '')
  FROM walk w
  CROSS JOIN LATERAL (SELECT doc->'blocks'->w.block_id->'attrs' AS attrs) a
  CROSS JOIN LATERAL (VALUES
    (1, CASE WHEN jsonb_typeof(a.attrs->'text') = 'string' THEN a.attrs->>'text' END),
    (2, CASE WHEN jsonb_typeof(a.attrs->'code') = 'string' THEN a.attrs->>'code' END),
    (3, (SELECT string_agg(run->>'text', '')
         FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(a.attrs->'caption') = 'array' THEN a.attrs->'caption' ELSE '[]'::jsonb END
         ) AS run
         WHERE jsonb_typeof(run->'text') = 'string')),
    (4, CASE WHEN jsonb_typeof(a.attrs->'cite') = 'string' THEN a.attrs->>'cite' END)
  ) AS part(n, value)
  WHERE part.value IS NOT NULL AND part.value <> ''
$$;

CREATE TABLE "post_search" (
  "post_id" bigint PRIMARY KEY REFERENCES "posts" ("id") ON DELETE CASCADE,
  "body_text" text NOT NULL DEFAULT '',
  "document" tsvector NOT NULL DEFAULT ''
);

CREATE INDEX idx_post_search_document ON post_search USING gin (document);

-- Rebuild the post_search rows of these posts from what is stored now. Term
-- names come from public taxonomies only: a private one's terms aren't shown
-- anywhere public, so they mustn't make a post findable either.
--
-- The posts are locked first (in id order, so two callers can't deadlock), and
-- the rebuild is a separate statement with its own snapshot. Two transactions
-- changing one post (say a title edit and a new term link) then rebuild one
-- after the other, and the second sees what the first committed; without the
-- lock each could read the other's change as not yet there and the last to
-- commit would leave a row missing the other's change.
CREATE FUNCTION golive_refresh_post_search(post_ids bigint[]) RETURNS void
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  PERFORM 1 FROM posts WHERE id = ANY(post_ids) ORDER BY id FOR UPDATE;

  INSERT INTO post_search (post_id, body_text, document)
  SELECT p.id, body.doc_text,
         setweight(to_tsvector(golive_search_config(), p.title), 'A')
      || setweight(to_tsvector(golive_search_config(), p.description), 'B')
      || setweight(to_tsvector(golive_search_config(), coalesce((
           SELECT string_agg(tt.name, ' ' ORDER BY tt.id)
           FROM post_taxonomy_relationships ptr
           JOIN taxonomy_terms tt ON tt.id = ptr.taxonomy_term_id
           JOIN taxonomy_types ty ON ty.id = tt.taxonomy_type_id
           WHERE ptr.post_id = p.id AND ty.public
         ), '')), 'B')
      || setweight(to_tsvector(golive_search_config(), body.doc_text), 'C')
  FROM posts p
  CROSS JOIN LATERAL (
    SELECT golive_block_doc_text(coalesce(
      (SELECT pv.block_doc FROM post_versions pv WHERE pv.id = p.published_version_id),
      p.published_block_doc
    )) AS doc_text
  ) body
  WHERE p.id = ANY(post_ids)
  ON CONFLICT (post_id) DO UPDATE
    SET body_text = EXCLUDED.body_text, document = EXCLUDED.document;
END
$$;

CREATE FUNCTION golive_posts_search_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM golive_refresh_post_search(ARRAY[NEW.id]);
  RETURN NULL;
END
$$;

CREATE TRIGGER posts_search_insert
  AFTER INSERT ON posts
  FOR EACH ROW EXECUTE FUNCTION golive_posts_search_trigger();

-- The collab server's stores write block_doc / block_revision / changed_at only,
-- so typing in the editor never fires this.
CREATE TRIGGER posts_search_update
  AFTER UPDATE OF title, description, published_version_id, published_block_doc ON posts
  FOR EACH ROW
  WHEN (OLD.title IS DISTINCT FROM NEW.title
     OR OLD.description IS DISTINCT FROM NEW.description
     OR OLD.published_version_id IS DISTINCT FROM NEW.published_version_id
     OR OLD.published_block_doc IS DISTINCT FROM NEW.published_block_doc)
  EXECUTE FUNCTION golive_posts_search_trigger();

-- Term links: once per statement, for every post the statement touched.
CREATE FUNCTION golive_post_terms_search_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM golive_refresh_post_search(ARRAY(SELECT DISTINCT post_id FROM changed_links));
  RETURN NULL;
END
$$;

CREATE TRIGGER post_terms_search_insert
  AFTER INSERT ON post_taxonomy_relationships
  REFERENCING NEW TABLE AS changed_links
  FOR EACH STATEMENT EXECUTE FUNCTION golive_post_terms_search_trigger();

CREATE TRIGGER post_terms_search_delete
  AFTER DELETE ON post_taxonomy_relationships
  REFERENCING OLD TABLE AS changed_links
  FOR EACH STATEMENT EXECUTE FUNCTION golive_post_terms_search_trigger();

-- A renamed term, or a taxonomy made public or private: its posts.
CREATE FUNCTION golive_term_search_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'taxonomy_terms' THEN
    PERFORM golive_refresh_post_search(ARRAY(
      SELECT ptr.post_id FROM post_taxonomy_relationships ptr WHERE ptr.taxonomy_term_id = NEW.id
    ));
  ELSE
    PERFORM golive_refresh_post_search(ARRAY(
      SELECT DISTINCT ptr.post_id
      FROM post_taxonomy_relationships ptr
      JOIN taxonomy_terms tt ON tt.id = ptr.taxonomy_term_id
      WHERE tt.taxonomy_type_id = NEW.id
    ));
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER taxonomy_terms_search_update
  AFTER UPDATE OF name ON taxonomy_terms
  FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION golive_term_search_trigger();

CREATE TRIGGER taxonomy_types_search_update
  AFTER UPDATE OF public ON taxonomy_types
  FOR EACH ROW WHEN (OLD.public IS DISTINCT FROM NEW.public)
  EXECUTE FUNCTION golive_term_search_trigger();

-- Backfill every existing post.
SELECT golive_refresh_post_search(ARRAY(SELECT id FROM posts));

COMMIT;
