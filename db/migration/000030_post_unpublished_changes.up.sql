-- "Changes not published" (#326): a published post whose working copy has moved
-- on since its last publish.
--
-- Two halves, both derived, nothing for a writer to keep up to date:
--   - the body: block_doc (the working copy, written only by the collab server's
--     store) against published_block_doc (what publish copied from it). Each gets
--     a stored md5 of its jsonb text, so lists and counts compare two short
--     strings instead of reading both documents. jsonb's text form is canonical
--     (keys sorted, whitespace normalized), so equal documents hash equally.
--   - the settings (#358): golive_post_settings() against published_settings, as
--     GET /posts/:id/settings already compared them.
--
-- Comparing content, not revisions: block_revision goes up on every store, so an
-- edit undone before the next publish (type a word, delete it) would count as a
-- change forever. With hashes the post is back to "Published" as soon as its
-- working copy equals the published one again, for the body and the settings
-- alike. The slug isn't compared: it isn't in the snapshot (it changes at once).
BEGIN;

ALTER TABLE posts
  ADD COLUMN block_doc_hash text GENERATED ALWAYS AS (md5(block_doc::text)) STORED,
  ADD COLUMN published_block_hash text GENERATED ALWAYS AS (md5(published_block_doc::text)) STORED;

-- Whether the post's working settings differ from its published ones (false when
-- nothing is published). The published term ids are compared as
-- post_published_terms has them: a term deleted since the publish is gone from
-- both sides (it can't be shown or published), not a pending change.
CREATE FUNCTION golive_post_settings_changed(target_post_id bigint, published jsonb) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT published IS NOT NULL
     AND jsonb_set(published, '{term_ids}', coalesce((
           SELECT jsonb_agg(ppt.taxonomy_term_id ORDER BY ppt.taxonomy_term_id)
           FROM post_published_terms ppt
           WHERE ppt.post_id = target_post_id
         ), '[]'::jsonb)) IS DISTINCT FROM golive_post_settings(target_post_id)
$$;

-- The flag itself, from a posts row's columns. Only a published post has
-- unpublished changes; the settings are read only when the bodies match.
CREATE FUNCTION golive_post_has_unpublished_changes(
  target_post_id bigint, status text, block_hash text, published_hash text, published jsonb
) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN status IS DISTINCT FROM 'published' THEN false
    WHEN block_hash IS DISTINCT FROM published_hash THEN true
    ELSE golive_post_settings_changed(target_post_id, published)
  END
$$;

COMMIT;
