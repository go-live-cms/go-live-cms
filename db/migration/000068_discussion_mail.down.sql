BEGIN;

DROP TRIGGER IF EXISTS "reader_comments_mail" ON "reader_comments";
DROP FUNCTION IF EXISTS golive_reader_comment_mail();
DROP FUNCTION IF EXISTS golive_discussion_digest_at(timestamptz);

DROP INDEX IF EXISTS discussion_mail_done;
DROP INDEX IF EXISTS discussion_mail_answered;
DROP INDEX IF EXISTS discussion_mail_commenter;
DROP INDEX IF EXISTS discussion_mail_member;
DROP INDEX IF EXISTS discussion_mail_open_member;
DROP INDEX IF EXISTS discussion_mail_open_reply;

ALTER TABLE discussion_mail
  DROP CONSTRAINT IF EXISTS discussion_mail_reply_answers,
  DROP CONSTRAINT IF EXISTS discussion_mail_reply_to_reader,
  DROP CONSTRAINT IF EXISTS discussion_mail_done,
  DROP COLUMN IF EXISTS created_at,
  DROP COLUMN IF EXISTS outcome,
  DROP COLUMN IF EXISTS answered_id;
ALTER TABLE discussion_mail RENAME COLUMN done_at TO sent_at;

ALTER TABLE users
  DROP COLUMN IF EXISTS notify_comment_moderation,
  DROP COLUMN IF EXISTS notify_post_comments;

COMMIT;
