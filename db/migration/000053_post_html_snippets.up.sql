-- Custom HTML (#428): the markup of a post's `html` blocks.
--
-- The block in the Yjs doc and block_doc holds only a snippet_id, so no Yjs update can
-- create or change markup. The rows are written only through admin-only API routes (and,
-- by the server, by a duplicate, a post from a template, and a restore). Always looked up
-- by (post_id, snippet_id): an id from another post finds nothing.
--
-- Publish copies the sanitized markup into the published block_doc (attrs.html), so
-- versions and the public site never read this table. published_html is the markup the
-- site shows for this row (NULL: none), the second half of "Changes not published": an
-- admin's edit changes no block_doc.
BEGIN;

CREATE TABLE post_html_snippets (
  post_id        bigint      NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  snippet_id     text        NOT NULL,
  html           text        NOT NULL,
  published_html text        NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, snippet_id),
  CONSTRAINT post_html_snippets_id_format
    CHECK (snippet_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);

-- A published document without its markup: what the working copy looks like, so the two
-- hashes of #326 compare equal when nothing but the copied markup differs.
CREATE FUNCTION golive_block_doc_without_html_markup(doc jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(doc -> 'blocks') IS DISTINCT FROM 'object' THEN doc
    WHEN NOT EXISTS (SELECT 1 FROM jsonb_each(doc -> 'blocks') b WHERE b.value ->> 'type' = 'html') THEN doc
    ELSE jsonb_set(doc, '{blocks}', (
      SELECT jsonb_object_agg(
        b.key,
        CASE WHEN b.value ->> 'type' = 'html' THEN b.value #- '{attrs,html}' ELSE b.value END
      )
      FROM jsonb_each(doc -> 'blocks') b
    ))
  END
$$;

ALTER TABLE posts DROP COLUMN published_block_hash;
ALTER TABLE posts
  ADD COLUMN published_block_hash text
  GENERATED ALWAYS AS (md5(golive_block_doc_without_html_markup(published_block_doc)::text)) STORED;

-- An admin changed the markup of a block the published post shows. A row the site doesn't
-- show (published_html NULL) can only matter through its block, which changes block_doc.
CREATE FUNCTION golive_post_html_snippets_changed(target_post_id bigint) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM post_html_snippets s
    WHERE s.post_id = target_post_id
      AND s.published_html IS NOT NULL
      AND s.html IS DISTINCT FROM s.published_html
  )
$$;

CREATE OR REPLACE FUNCTION golive_post_has_unpublished_changes(
  target_post_id bigint, status text, block_hash text, published_hash text, published jsonb
) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN status IS DISTINCT FROM 'published' THEN false
    WHEN block_hash IS DISTINCT FROM published_hash THEN true
    WHEN golive_post_html_snippets_changed(target_post_id) THEN true
    ELSE golive_post_settings_changed(target_post_id, published)
  END
$$;

COMMIT;
