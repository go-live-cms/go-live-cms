BEGIN;

UPDATE post_types
SET supports = supports - 'comments'
WHERE supports ? 'comments';

ALTER TABLE settings
  DROP COLUMN comments_privacy_page_id,
  DROP COLUMN comments_notice,
  DROP COLUMN comments_per_page,
  DROP COLUMN comments_order,
  DROP COLUMN comments_threading,
  DROP COLUMN comments_close_after_days,
  DROP COLUMN comments_spam_words,
  DROP COLUMN comments_hold_words,
  DROP COLUMN comments_max_links,
  DROP COLUMN comments_moderation,
  DROP COLUMN comments_enabled;

DROP TRIGGER posts_first_published ON posts;
DROP FUNCTION golive_post_first_published();

ALTER TABLE posts
  DROP COLUMN first_published_at,
  DROP COLUMN discussion;

DROP TABLE discussion_mail;
DROP TABLE reader_comment_unsubscribe_tokens;
DROP TABLE reader_comments;
DROP TABLE commenter_keys;
DROP TABLE commenters;

COMMIT;
