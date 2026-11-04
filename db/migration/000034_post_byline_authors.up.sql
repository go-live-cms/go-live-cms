-- Byline authors (#319): who a post credits, separate from its owner.
--
-- posts.user_id stays the owner, the only thing permissions read (#135). The byline
-- is user_posts (post_id, user_id, "order"): one or more users, in credit order,
-- shown on the post, in the lists and on the author pages (#350). A new post's
-- byline is its owner unless the request names others. Being credited gives no
-- access to the post.
--
-- The byline is a post setting (#358): golive_post_settings() now snapshots it as
-- author_ids (user ids in byline order), so on a published post a byline edit
-- reaches the site on Update, every version records it, restoring a version brings
-- it back, and #326's "changes not published" flag sees it (it compares snapshots).
--
-- post_published_authors is the published byline as rows, like
-- post_published_terms (000027): the author pages, "Written by" cards and the public
-- lists join it. A trigger keeps it equal to published_settings.author_ids; nobody
-- writes it by hand. Ids of users that no longer exist are skipped.
BEGIN;

-- Bylines were never empty on purpose, but nothing enforced it: credit the owner
-- wherever a post has none, so every post has one before it is snapshotted.
INSERT INTO user_posts (post_id, user_id, "order")
SELECT p.id, p.user_id, 0
FROM posts p
WHERE NOT EXISTS (SELECT 1 FROM user_posts up WHERE up.post_id = p.id);

-- The byline in credit order, for the editor and the bulk actions (#327).
CREATE INDEX idx_user_posts_post_order ON user_posts (post_id, "order");
-- "Posts by" filters and the removal of a member (#333) look bylines up by user.
CREATE INDEX idx_user_posts_user_id ON user_posts (user_id);

-- The 000031 snapshot plus the byline:
--   {..., "author_ids": [4, 9]}
CREATE OR REPLACE FUNCTION golive_post_settings(target_post_id bigint) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'title', p.title,
    'description', p.description,
    'featured_image', (
      SELECT jsonb_build_object(
        'id', (
          SELECT CASE WHEN tid.meta_value ~ '^[0-9]{1,18}$' THEN tid.meta_value::bigint END
          FROM post_meta tid
          WHERE tid.post_id = p.id AND tid.meta_key = '_thumbnail_id'
        ),
        'url', turl.meta_value
      )
      FROM post_meta turl
      WHERE turl.post_id = p.id AND turl.meta_key = '_thumbnail_url'
        AND coalesce(turl.meta_value, '') <> ''
    ),
    'term_ids', coalesce((
      SELECT jsonb_agg(DISTINCT ptr.taxonomy_term_id ORDER BY ptr.taxonomy_term_id)
      FROM post_taxonomy_relationships ptr
      WHERE ptr.post_id = p.id
    ), '[]'::jsonb),
    'seo_title', p.seo_title,
    'seo_description', p.seo_description,
    'social_image_id', p.social_image_id,
    'noindex', p.noindex,
    'canonical_url', p.canonical_url,
    'author_ids', coalesce((
      SELECT jsonb_agg(up.user_id ORDER BY up."order", up.user_id)
      FROM user_posts up
      WHERE up.post_id = p.id
    ), '[]'::jsonb)
  )
  FROM posts p
  WHERE p.id = target_post_id
$$;

CREATE TABLE post_published_authors (
  post_id bigint NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Position in the published byline, from 0.
  position int NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX idx_post_published_authors_user_id ON post_published_authors (user_id);

-- Rebuild post_published_authors for the post from its published_settings.
CREATE FUNCTION golive_sync_published_authors_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM post_published_authors WHERE post_id = NEW.id;
  IF jsonb_typeof(NEW.published_settings->'author_ids') = 'array' THEN
    INSERT INTO post_published_authors (post_id, user_id, position)
    SELECT DISTINCT ON (u.id) NEW.id, u.id, (a.ord - 1)::int
    FROM jsonb_array_elements_text(NEW.published_settings->'author_ids') WITH ORDINALITY AS a(value, ord)
    JOIN users u ON a.value ~ '^[0-9]{1,18}$' AND u.id = a.value::bigint
    ORDER BY u.id, a.ord;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER posts_published_authors_insert
  AFTER INSERT ON posts
  FOR EACH ROW WHEN (NEW.published_settings IS NOT NULL)
  EXECUTE FUNCTION golive_sync_published_authors_trigger();

CREATE TRIGGER posts_published_authors_update
  AFTER UPDATE OF published_settings ON posts
  FOR EACH ROW WHEN (OLD.published_settings IS DISTINCT FROM NEW.published_settings)
  EXECUTE FUNCTION golive_sync_published_authors_trigger();

-- A post's byline as the lists return it (#340): [{id, username, full_name}] in
-- credit order. The working one is user_posts (the admin); the published one is
-- post_published_authors (the public site), [] for a post with no snapshot.
CREATE FUNCTION golive_post_byline(target_post_id bigint) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    jsonb_agg(jsonb_build_object('id', u.id, 'username', u.username, 'full_name', u.full_name) ORDER BY up."order", u.id),
    '[]'::jsonb)
  FROM user_posts up
  JOIN users u ON u.id = up.user_id
  WHERE up.post_id = target_post_id
$$;

CREATE FUNCTION golive_post_published_byline(target_post_id bigint) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    jsonb_agg(jsonb_build_object('id', u.id, 'username', u.username, 'full_name', u.full_name) ORDER BY ppa.position, u.id),
    '[]'::jsonb)
  FROM post_published_authors ppa
  JOIN users u ON u.id = ppa.user_id
  WHERE ppa.post_id = target_post_id
$$;

-- Backfill: the byline the site shows now (user_posts) becomes the published one,
-- so nothing changes on deploy and no published post shows a pending change. The
-- current version gets it too, like 000027; older versions keep no author_ids, and
-- restoring one leaves the working byline as it is. The UPDATE fires the trigger.
UPDATE post_versions v
SET settings = v.settings || jsonb_build_object('author_ids', golive_post_settings(p.id)->'author_ids')
FROM posts p
WHERE p.published_version_id = v.id AND v.settings IS NOT NULL;

UPDATE posts
SET published_settings = published_settings || jsonb_build_object('author_ids', golive_post_settings(id)->'author_ids')
WHERE published_settings IS NOT NULL;

COMMIT;
