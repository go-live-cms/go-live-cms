DROP TABLE IF EXISTS "email_change_tokens";

-- The 000034 bylines, without the avatar, before the column goes (SQL function
-- bodies aren't dependency-tracked, so they would fail at call time instead).
CREATE OR REPLACE FUNCTION golive_post_byline(target_post_id bigint) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    jsonb_agg(jsonb_build_object('id', u.id, 'username', u.username, 'full_name', u.full_name) ORDER BY up."order", u.id),
    '[]'::jsonb)
  FROM user_posts up
  JOIN users u ON u.id = up.user_id
  WHERE up.post_id = target_post_id
$$;

CREATE OR REPLACE FUNCTION golive_post_published_byline(target_post_id bigint) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    jsonb_agg(jsonb_build_object('id', u.id, 'username', u.username, 'full_name', u.full_name) ORDER BY ppa.position, u.id),
    '[]'::jsonb)
  FROM post_published_authors ppa
  JOIN users u ON u.id = ppa.user_id
  WHERE ppa.post_id = target_post_id
$$;

ALTER TABLE "users" DROP COLUMN IF EXISTS "avatar_url";