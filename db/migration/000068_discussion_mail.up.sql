-- Reader comment mail (#528, docs/design/reader-comments.md 8): members' preferences
-- (8.3), and the outbox 000061 created (discussion_mail, 8.4) made ready to send.
--
--   users.notify_post_comments       "Comments on my posts": each (coalesced, five minutes
--                                    after the approval) | digest (daily, 08:00 in the
--                                    site's zone; the default, section 18 decision 8) | off.
--   users.notify_comment_moderation  "Comments to moderate" (editors and admins): hourly
--                                    (at most one mail an hour) | off.
--   discussion_mail.answered_id      a reply mail's comment answered: the one-click
--                                    unsubscribe can turn off one comment's replies only
--                                    (8.2), so reply mails coalesce per comment answered.
--   discussion_mail.done_at          was sent_at: when the row was finished, with
--   discussion_mail.outcome          sent | dropped (nothing left to say when it was
--                                    built) | failed (out of attempts).
--
-- The reply and author rows are written by a trigger, in the transaction that approves
-- the comment (every path: moderation, bulk, a member's comment, a confirmation, a keyed
-- comment, a restore), so an approval that commits always has its mail and one that
-- rolls back has none. A comment joins its recipient's open row (not yet claimed by the
-- sender) instead of adding one, so a busy thread sends one mail. Moderation mails are
-- not written here: they describe the queue, which RunDiscussionMail reads (api/
-- discussion_mail.go), so no pending comment fans out a row per moderator.
--
-- Rows hold ids only. The sender resolves them when it builds the mail, so a comment
-- trashed meanwhile is left out, an unsubscribed, blocked or erased commenter (whose row
-- and outbox rows go together, ON DELETE CASCADE) or a removed member gets nothing.
BEGIN;

ALTER TABLE users
  ADD COLUMN notify_post_comments varchar NOT NULL DEFAULT 'digest'
    CONSTRAINT users_notify_post_comments CHECK (notify_post_comments IN ('each', 'digest', 'off')),
  ADD COLUMN notify_comment_moderation varchar NOT NULL DEFAULT 'hourly'
    CONSTRAINT users_notify_comment_moderation CHECK (notify_comment_moderation IN ('hourly', 'off'));

ALTER TABLE discussion_mail RENAME COLUMN sent_at TO done_at;
ALTER TABLE discussion_mail
  ADD COLUMN answered_id bigint REFERENCES reader_comments (id) ON DELETE CASCADE,
  ADD COLUMN outcome varchar CONSTRAINT discussion_mail_outcome CHECK (outcome IN ('sent', 'dropped', 'failed')),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT discussion_mail_done CHECK ((done_at IS NULL) = (outcome IS NULL)),
  -- A reader gets reply mails only; members get author and moderation mails.
  ADD CONSTRAINT discussion_mail_reply_to_reader CHECK ((kind = 'reply') = (commenter_id IS NOT NULL)),
  ADD CONSTRAINT discussion_mail_reply_answers CHECK ((kind = 'reply') = (answered_id IS NOT NULL));

-- One open row per recipient and kind (per comment answered for replies): what a new
-- comment joins. A row leaves it once claimed (attempts > 0) or finished.
CREATE UNIQUE INDEX discussion_mail_open_reply ON discussion_mail (answered_id)
  WHERE kind = 'reply' AND done_at IS NULL AND attempts = 0;
CREATE UNIQUE INDEX discussion_mail_open_member ON discussion_mail (kind, user_id)
  WHERE user_id IS NOT NULL AND done_at IS NULL AND attempts = 0;
-- The cascades, and "was this comment already mailed to them" (rows live 7 days after
-- they are done).
CREATE INDEX discussion_mail_member ON discussion_mail (user_id, kind) WHERE user_id IS NOT NULL;
CREATE INDEX discussion_mail_commenter ON discussion_mail (commenter_id) WHERE commenter_id IS NOT NULL;
CREATE INDEX discussion_mail_answered ON discussion_mail (answered_id) WHERE answered_id IS NOT NULL;
CREATE INDEX discussion_mail_done ON discussion_mail (done_at) WHERE done_at IS NOT NULL;

-- The next daily digest after at: 08:00 in the site's zone. A zone Postgres doesn't
-- know (the setting is checked by Go's database, not this one) falls back to UTC rather
-- than failing the approval that asked.
CREATE FUNCTION golive_discussion_digest_at(at timestamptz) RETURNS timestamptz
LANGUAGE plpgsql STABLE AS $$
DECLARE
  zone text;
  local timestamp;
  due timestamp;
BEGIN
  SELECT NULLIF(s.site_timezone, '') INTO zone FROM settings s WHERE s.id = 1;
  zone := COALESCE(zone, 'UTC');
  BEGIN
    local := at AT TIME ZONE zone;
  EXCEPTION WHEN invalid_parameter_value THEN
    zone := 'UTC';
    local := at AT TIME ZONE zone;
  END;
  due := date_trunc('day', local) + interval '8 hours';
  IF due <= local THEN
    due := due + interval '1 day';
  END IF;
  RETURN due AT TIME ZONE zone;
END;
$$;

-- A comment becoming approved (inserted approved, or a status change into approved; a
-- tombstone never) queues:
--
--   reply   to the commenter of the comment it answers, when that comment asked for
--           replies (notify_replies) and isn't by the same commenter;
--   author  to each member on the post's published byline whose preference isn't off,
--           unless they wrote the comment or approved it themselves.
--
-- Each joins the recipient's open row, or opens one due in five minutes (a digest: at
-- the next one). A comment already in one of the recipient's rows (approved again after
-- an unapprove, restored from the trash) isn't queued twice. Nothing is queued while
-- comments are off for the site.
CREATE FUNCTION golive_reader_comment_mail() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent reader_comments%ROWTYPE;
BEGIN
  IF NEW.status <> 'approved' OR NEW.removed_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'approved' THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM settings s WHERE s.id = 1 AND s.comments_enabled) THEN
    RETURN NULL;
  END IF;

  IF NEW.parent_id IS NOT NULL THEN
    SELECT * INTO parent FROM reader_comments rc WHERE rc.id = NEW.parent_id;
    IF FOUND
       AND parent.commenter_id IS NOT NULL
       AND parent.notify_replies
       AND parent.removed_at IS NULL
       AND parent.commenter_id IS DISTINCT FROM NEW.commenter_id
       AND NOT EXISTS (SELECT 1 FROM discussion_mail m
                       WHERE m.answered_id = parent.id AND NEW.id = ANY (m.comment_ids)) THEN
      INSERT INTO discussion_mail (kind, commenter_id, answered_id, post_id, comment_ids, due_at)
      VALUES ('reply', parent.commenter_id, parent.id, NEW.post_id, ARRAY[NEW.id], now() + interval '5 minutes')
      ON CONFLICT (answered_id) WHERE kind = 'reply' AND done_at IS NULL AND attempts = 0
      DO UPDATE SET comment_ids = discussion_mail.comment_ids || EXCLUDED.comment_ids;
    END IF;
  END IF;

  INSERT INTO discussion_mail (kind, user_id, post_id, comment_ids, due_at)
  SELECT 'author', u.id, NEW.post_id, ARRAY[NEW.id],
         CASE u.notify_post_comments
           WHEN 'each' THEN now() + interval '5 minutes'
           ELSE golive_discussion_digest_at(now())
         END
  FROM post_published_authors a
  JOIN users u ON u.id = a.user_id
  WHERE a.post_id = NEW.post_id
    AND u.notify_post_comments <> 'off'
    AND u.id IS DISTINCT FROM NEW.author_user_id
    AND u.id IS DISTINCT FROM NEW.moderated_by
    AND NOT EXISTS (SELECT 1 FROM discussion_mail m
                    WHERE m.kind = 'author' AND m.user_id = u.id AND NEW.id = ANY (m.comment_ids))
  ON CONFLICT (kind, user_id) WHERE user_id IS NOT NULL AND done_at IS NULL AND attempts = 0
  DO UPDATE SET comment_ids = discussion_mail.comment_ids || EXCLUDED.comment_ids,
                post_id = CASE WHEN discussion_mail.post_id = EXCLUDED.post_id THEN discussion_mail.post_id END;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "reader_comments_mail"
AFTER INSERT OR UPDATE OF status ON "reader_comments"
FOR EACH ROW
EXECUTE PROCEDURE golive_reader_comment_mail();

COMMIT;
