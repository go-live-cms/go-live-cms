-- Reader comments, phase 1 (#522, design docs/design/reader-comments.md 6, 7, 12).
--
-- Storage only: nothing reads or writes these tables from /public yet, and
-- settings.comments_enabled starts off (its switch is hidden until the moderation
-- screens ship). The names say "reader comment", "commenter" or "discussion" so they
-- never meet #192's editorial block comments (post_comments, post_comment_threads).
--
--   commenters                         one email address on this site (3.2). Never public.
--   commenter_keys                     browser keys (3.3), stored as SHA-256 only.
--   reader_comments                    the comments (6.1), threaded by parent_id/root_id (6.2).
--   reader_comment_unsubscribe_tokens  reply-mail unsubscribe tokens (8.2), hashes only.
--   discussion_mail                    the notification outbox (8.4); recipients by id.
--   posts.discussion                   default | open | closed | off (12.3). NOT in
--                                      golive_post_settings(): it applies at once, outside
--                                      the publish snapshot, and never makes a post show
--                                      "changes not published".
--   posts.first_published_at           when the post first went live, for "close after N
--                                      days" (12.4); set once by a trigger.
--   settings.comments_*                Settings > Discussion (12.1).
--   post_types.supports                gains "comments" for post (12.2).
--
-- No IP address is ever stored: network_hash is a keyed hash (7.2), NULLed after 30
-- days by RunDiscussionMaintenance (api/discussion_maintenance.go, 6.6), which also
-- applies the other retention rules of section 18, decision 13.
BEGIN;

CREATE TABLE commenters (
  id           bigserial PRIMARY KEY,
  -- As typed, for mail; matching uses email_lower (lower-cased and trimmed).
  email        varchar(254) NOT NULL,
  email_lower  varchar(254) NOT NULL UNIQUE,
  -- The latest name used; each comment keeps the one it was posted with.
  display_name varchar(60)  NOT NULL CHECK (btrim(display_name) <> ''),
  verified_at  timestamptz,
  -- 5.5: later comments go to spam silently. Kept by the maintenance job.
  blocked_at   timestamptz,
  -- 4.2 previous_spam: outlives the spam rows themselves (deleted after 30 days).
  last_spam_at timestamptz,
  -- Reserved for reader accounts (3.1 B).
  user_id      bigint REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commenters_email_lower_trimmed CHECK (email_lower = btrim(email_lower) AND email_lower <> '')
);

-- Browser keys (3.3): only the SHA-256 of the cookie's value is stored.
CREATE TABLE commenter_keys (
  key_hash     bytea  PRIMARY KEY CHECK (octet_length(key_hash) = 32),
  commenter_id bigint NOT NULL REFERENCES commenters (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX commenter_keys_commenter ON commenter_keys (commenter_id);
CREATE INDEX commenter_keys_expires ON commenter_keys (expires_at);

CREATE TABLE reader_comments (
  id             bigserial PRIMARY KEY,
  -- A post deleted for good takes its thread with it; trash and unpublish keep it (6.5).
  post_id        bigint NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  -- The comment it answers (6.2).
  parent_id      bigint REFERENCES reader_comments (id) ON DELETE SET NULL,
  -- Its thread's top-level comment; NULL for a top-level one. The cascade only runs when
  -- the post goes, or when a root with no approved replies is deleted: one with approved
  -- replies becomes a tombstone instead (6.4, db.DeleteReaderCommentTx).
  root_id        bigint REFERENCES reader_comments (id) ON DELETE CASCADE,
  -- A reader's (commenter) or a member's (author_user_id, 3.4); neither once erased or
  -- tombstoned.
  commenter_id   bigint REFERENCES commenters (id) ON DELETE SET NULL,
  author_user_id bigint REFERENCES users (id) ON DELETE SET NULL,
  -- As posted ('' only on a tombstone).
  display_name   varchar(60) NOT NULL,
  -- Plain text (6.3), validated in Go (api/discussion_text.go); '' only on a tombstone.
  body           text NOT NULL CHECK (char_length(body) <= 4000),
  status         varchar NOT NULL CHECK (status IN ('unconfirmed', 'pending', 'approved', 'spam', 'trash')),
  -- The status a restore puts back.
  trashed_from   varchar CHECK (trashed_from IN ('unconfirmed', 'pending', 'approved', 'spam')),
  -- Why the rules held (or spammed) it (4.2), NULL when nothing did; held_detail is a
  -- guard's reason or the matched word.
  held_reason    varchar(40) CHECK (held_reason ~ '^[a-z][a-z_]{0,39}$'),
  held_detail    varchar(200),
  -- 8.2: the reader's consent to reply mails, per comment.
  notify_replies boolean NOT NULL DEFAULT false,
  -- 7.2: HMAC of the client's network, never the address; NULLed after 30 days.
  network_hash   bytea,
  -- A tombstone (6.4): removed, kept because approved replies hang from it.
  removed_at     timestamptz,
  -- While unconfirmed (3.3): the SHA-256 of the mailed token.
  confirm_token_hash bytea,
  -- A plain default, so a later importer can write it (6.1).
  created_at     timestamptz NOT NULL DEFAULT now(),
  approved_at    timestamptz,
  moderated_by   bigint REFERENCES users (id) ON DELETE SET NULL,
  moderated_at   timestamptz,
  -- A member's own comment only (6.4).
  edited_at      timestamptz,
  CONSTRAINT reader_comments_one_author CHECK ((commenter_id IS NULL) OR (author_user_id IS NULL)),
  CONSTRAINT reader_comments_trash CHECK ((status = 'trash') = (trashed_from IS NOT NULL)),
  -- A top-level comment has neither; a reply always has its root. Its parent may be gone
  -- (a deleted reply it answered: ON DELETE SET NULL).
  CONSTRAINT reader_comments_threading CHECK (
    (root_id IS NOT NULL OR parent_id IS NULL) AND root_id IS DISTINCT FROM id AND parent_id IS DISTINCT FROM id
  ),
  CONSTRAINT reader_comments_body CHECK (removed_at IS NOT NULL OR btrim(body) <> ''),
  -- A tombstone keeps nothing about who wrote it or what.
  CONSTRAINT reader_comments_tombstone CHECK (
    removed_at IS NULL OR (
      status = 'approved' AND body = '' AND display_name = ''
      AND commenter_id IS NULL AND author_user_id IS NULL
      AND network_hash IS NULL AND confirm_token_hash IS NULL AND NOT notify_replies
    )
  ),
  CONSTRAINT reader_comments_confirm_token CHECK (confirm_token_hash IS NULL OR status = 'unconfirmed')
);
-- The public thread read (C3): approved comments of a post, by thread.
CREATE INDEX reader_comments_thread ON reader_comments (post_id, root_id, created_at) WHERE status = 'approved';
-- The moderation queue (4.4) and the retention job (6.6).
CREATE INDEX reader_comments_queue ON reader_comments (status, created_at DESC);
CREATE INDEX reader_comments_by_commenter ON reader_comments (commenter_id);
-- The FK actions (root cascade, parent set null) and "has approved replies" (6.4).
CREATE INDEX reader_comments_root ON reader_comments (root_id) WHERE root_id IS NOT NULL;
CREATE INDEX reader_comments_parent ON reader_comments (parent_id) WHERE parent_id IS NOT NULL;
-- Every post's comments, every status: the queue's post filter and the post's cascade.
CREATE INDEX reader_comments_post ON reader_comments (post_id, created_at DESC);
CREATE UNIQUE INDEX reader_comments_confirm_token ON reader_comments (confirm_token_hash) WHERE confirm_token_hash IS NOT NULL;
CREATE INDEX reader_comments_network ON reader_comments (network_hash, created_at) WHERE network_hash IS NOT NULL;

-- Unsubscribe tokens for reply notifications (8.2), one per comment that asked.
CREATE TABLE reader_comment_unsubscribe_tokens (
  token_hash bytea  PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  comment_id bigint NOT NULL REFERENCES reader_comments (id) ON DELETE CASCADE
);
CREATE INDEX reader_comment_unsubscribe_tokens_comment ON reader_comment_unsubscribe_tokens (comment_id);

-- The notification outbox (8.4). A recipient is an id, resolved to an address when the
-- mail is built, so an erased commenter or a removed member is simply skipped.
CREATE TABLE discussion_mail (
  id            bigserial PRIMARY KEY,
  kind          varchar NOT NULL CHECK (kind IN ('reply', 'author', 'moderation')),
  commenter_id  bigint REFERENCES commenters (id) ON DELETE CASCADE,
  user_id       bigint REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT discussion_mail_one_recipient CHECK ((commenter_id IS NULL) <> (user_id IS NULL)),
  -- No FK: a mail about a post deleted meanwhile is dropped when it is built.
  post_id       bigint,
  -- Coalesced: comments joining a row not yet due.
  comment_ids   bigint[] NOT NULL,
  due_at        timestamptz NOT NULL,
  -- The sender's lease (as post_reminders are claimed).
  claimed_until timestamptz,
  attempts      int NOT NULL DEFAULT 0,
  sent_at       timestamptz
);
CREATE INDEX discussion_mail_due ON discussion_mail (due_at) WHERE sent_at IS NULL;

-- 12.3: the post's Discussion choice. Outside the publish snapshot on purpose.
ALTER TABLE posts
  ADD COLUMN discussion varchar NOT NULL DEFAULT 'default'
    CONSTRAINT posts_discussion_choice CHECK (discussion IN ('default', 'open', 'closed', 'off')),
  ADD COLUMN first_published_at timestamptz;

-- When the post first went live (12.4). posts had no publish date (publish_at is the
-- schedule). Set once, when post_status first becomes 'published' (the Publish button,
-- the scheduler, a seed's insert); unpublish, re-publish, an Update, the trash and a
-- restore never move it, and no writer can change it once set.
CREATE FUNCTION golive_post_first_published() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.first_published_at IS NOT NULL THEN
    NEW.first_published_at := OLD.first_published_at;
  ELSIF NEW.post_status = 'published' AND NEW.first_published_at IS NULL THEN
    NEW.first_published_at := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER posts_first_published
BEFORE INSERT OR UPDATE OF post_status, first_published_at ON posts
FOR EACH ROW
EXECUTE PROCEDURE golive_post_first_published();

-- Backfill: a post_versions row is written only by a publish (#136), so a post's earliest
-- version is when it first went live, whatever its status now (unpublished, trashed). A
-- published post without versions (inserted as published, before #136) falls back to
-- its creation.
UPDATE posts p
SET first_published_at = v.first_at
FROM (SELECT post_id, min(created_at) AS first_at FROM post_versions GROUP BY post_id) v
WHERE v.post_id = p.id AND p.first_published_at IS NULL;

UPDATE posts
SET first_published_at = created_at
WHERE first_published_at IS NULL
  AND (post_status = 'published' OR trashed_from_status = 'published');

-- 12.1: Settings > Discussion. comments_enabled starts off: no section renders and the
-- write routes answer 409 comments_off. Word lists: at most 500 entries of at most 64
-- characters (checked in Go, api/discussion_settings.go). comments_notice '' = core's
-- text (7.5).
ALTER TABLE settings
  ADD COLUMN comments_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN comments_moderation varchar NOT NULL DEFAULT 'first'
    CONSTRAINT settings_comments_moderation CHECK (comments_moderation IN ('all', 'first', 'none')),
  ADD COLUMN comments_max_links integer NOT NULL DEFAULT 1
    CONSTRAINT settings_comments_max_links CHECK (comments_max_links BETWEEN 0 AND 10),
  ADD COLUMN comments_hold_words text[] NOT NULL DEFAULT '{}'
    CONSTRAINT settings_comments_hold_words CHECK (cardinality(comments_hold_words) <= 500),
  ADD COLUMN comments_spam_words text[] NOT NULL DEFAULT '{}'
    CONSTRAINT settings_comments_spam_words CHECK (cardinality(comments_spam_words) <= 500),
  ADD COLUMN comments_close_after_days integer NOT NULL DEFAULT 0
    CONSTRAINT settings_comments_close_after_days CHECK (comments_close_after_days BETWEEN 0 AND 3650),
  ADD COLUMN comments_threading varchar NOT NULL DEFAULT 'replies'
    CONSTRAINT settings_comments_threading CHECK (comments_threading IN ('replies', 'flat')),
  ADD COLUMN comments_order varchar NOT NULL DEFAULT 'oldest'
    CONSTRAINT settings_comments_order CHECK (comments_order IN ('oldest', 'newest')),
  ADD COLUMN comments_per_page integer NOT NULL DEFAULT 30
    CONSTRAINT settings_comments_per_page CHECK (comments_per_page BETWEEN 10 AND 100),
  ADD COLUMN comments_notice text NOT NULL DEFAULT ''
    CONSTRAINT settings_comments_notice CHECK (char_length(comments_notice) <= 400),
  ADD COLUMN comments_privacy_page_id bigint NULL REFERENCES posts (id) ON DELETE SET NULL;

-- 12.2: Posts take comments; Pages and custom types don't until an admin says so.
UPDATE post_types
SET supports = supports || '["comments"]'::jsonb
WHERE name = 'post' AND NOT supports ? 'comments';

COMMIT;
