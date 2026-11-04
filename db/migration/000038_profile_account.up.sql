-- Profile: avatar, email change, signing out other devices (#334).

-- The avatar is a dedicated upload, not a media item: a square crop the API encodes
-- itself (no metadata survives), stored under <UPLOAD_PATH>/_avatars/ with an
-- unguessable name (#399). The column holds its /uploads URL path ('' = none), the form
-- every response uses, so bylines built in SQL can return it as is.
ALTER TABLE "users" ADD COLUMN "avatar_url" varchar NOT NULL DEFAULT '';

-- The bylines the lists return (000034, #319) gain the avatar: [{id, username,
-- full_name, avatar}], avatar null when there is none.
CREATE OR REPLACE FUNCTION golive_post_byline(target_post_id bigint) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    jsonb_agg(jsonb_build_object('id', u.id, 'username', u.username, 'full_name', u.full_name, 'avatar', NULLIF(u.avatar_url, '')) ORDER BY up."order", u.id),
    '[]'::jsonb)
  FROM user_posts up
  JOIN users u ON u.id = up.user_id
  WHERE up.post_id = target_post_id
$$;

CREATE OR REPLACE FUNCTION golive_post_published_byline(target_post_id bigint) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    jsonb_agg(jsonb_build_object('id', u.id, 'username', u.username, 'full_name', u.full_name, 'avatar', NULLIF(u.avatar_url, '')) ORDER BY ppa.position, u.id),
    '[]'::jsonb)
  FROM post_published_authors ppa
  JOIN users u ON u.id = ppa.user_id
  WHERE ppa.post_id = target_post_id
$$;

-- A requested email change, until the new address confirms it. Like invitations and
-- password resets (000018) only the token's SHA-256 is stored, it is single use
-- (used_at) and it expires. new_email is not unique: two accounts may both ask for
-- an address nobody has; the first to confirm gets it.
CREATE TABLE "email_change_tokens" (
  "id" bigserial PRIMARY KEY,
  "user_id" bigint NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "new_email" varchar NOT NULL,
  "token_hash" bytea NOT NULL UNIQUE,
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE INDEX "email_change_tokens_user_id_idx" ON "email_change_tokens" ("user_id");
