-- Reader comment events for plugins (#530, docs/design/reader-comments.md 14.1): a
-- trigger on reader_comments writes to 000055's plugin_events exactly as the posts
-- trigger does, so every path that changes a comment (the write path, the
-- confirmation, moderation, deletion, the retention job) announces it in its own
-- transaction, and a path added later can't forget to. The dispatcher, ordering (per
-- plugin and post_id, the comment's post, so a thread's events arrive in order),
-- retries and webhooks are 000055's and #460's, unchanged.
--
-- The events:
--
--   comment.created     an INSERT that isn't unconfirmed (a keyed reader's comment, one
--                       stored as spam, a member's), or status leaving unconfirmed (the
--                       confirmation). An unconfirmed comment is not created yet.
--   comment.approved    status becomes approved (after comment.created when it is
--                       created approved).
--   comment.unapproved  status leaves approved for pending.
--   comment.spammed     status becomes spam (after comment.created when it is created
--                       as spam).
--   comment.trashed     status becomes trash.
--   comment.deleted     a DELETE, or a tombstone (removed_at set). Not for an
--                       unconfirmed comment, nor a tombstone's own later DELETE (it was
--                       announced), nor the comments of a post deleted for good, whose
--                       post.deleted stands for them (the cascade would write one event
--                       per comment).
--
-- data holds ids and small facts only, never a name, text or address (7.1): comment_id,
-- root_id (absent on a top-level comment), status (after the change; on
-- comment.deleted the status it had), previous_status (absent on an INSERT and on
-- comment.deleted) and by_member. actor_id is the member who wrote it on
-- comment.created, the moderator on a status change a moderator made, else NULL.
--
-- No subscriber, no row: the insert is filtered by golive_plugin_event_subscribed, so a
-- site with no comment plugin writes nothing, and nothing here can fail a comment write
-- but the insert itself.
CREATE FUNCTION golive_reader_comment_plugin_events() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  events text[] := '{}';
  c reader_comments%ROWTYPE;
  previous text;
  created boolean := false;
  by_member boolean;
  moderator bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'unconfirmed' OR OLD.removed_at IS NOT NULL THEN
      RETURN NULL;
    END IF;
    -- A cascade from a post deleted for good: the post row is already gone.
    IF NOT EXISTS (SELECT 1 FROM posts p WHERE p.id = OLD.post_id) THEN
      RETURN NULL;
    END IF;
    c := OLD;
    by_member := OLD.author_user_id IS NOT NULL;
    events := ARRAY['comment.deleted'];
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.status = 'unconfirmed' THEN
      RETURN NULL;
    END IF;
    c := NEW;
    by_member := NEW.author_user_id IS NOT NULL;
    created := true;
  ELSE
    c := NEW;
    by_member := NEW.author_user_id IS NOT NULL;
    IF NEW.removed_at IS NOT NULL AND OLD.removed_at IS NULL THEN
      IF OLD.status = 'unconfirmed' THEN
        RETURN NULL;
      END IF;
      -- A tombstone keeps nothing about its author or status: describe what it was.
      c.status := OLD.status;
      by_member := OLD.author_user_id IS NOT NULL;
      events := ARRAY['comment.deleted'];
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
      previous := OLD.status;
      IF NEW.moderated_at IS DISTINCT FROM OLD.moderated_at THEN
        moderator := NEW.moderated_by;
      END IF;
      IF OLD.status = 'unconfirmed' THEN
        created := true;
      ELSIF NEW.status = 'approved' THEN
        events := ARRAY['comment.approved'];
      ELSIF NEW.status = 'pending' AND OLD.status = 'approved' THEN
        events := ARRAY['comment.unapproved'];
      ELSIF NEW.status = 'spam' THEN
        events := ARRAY['comment.spammed'];
      ELSIF NEW.status = 'trash' THEN
        events := ARRAY['comment.trashed'];
      END IF;
    END IF;
  END IF;

  IF created THEN
    events := ARRAY['comment.created'];
    IF c.status = 'approved' THEN
      events := events || 'comment.approved'::text;
    ELSIF c.status = 'spam' THEN
      events := events || 'comment.spammed'::text;
    END IF;
  END IF;

  IF cardinality(events) = 0 THEN
    RETURN NULL;
  END IF;

  INSERT INTO plugin_events (event, post_id, actor_id, data)
  SELECT e.name,
         c.post_id,
         CASE WHEN e.name = 'comment.created' THEN c.author_user_id
              WHEN e.name = 'comment.deleted' THEN NULL
              WHEN TG_OP = 'INSERT' THEN c.author_user_id
              ELSE moderator END,
         jsonb_strip_nulls(jsonb_build_object(
           'comment_id', c.id,
           'root_id', c.root_id,
           'status', c.status,
           'previous_status', CASE WHEN e.name <> 'comment.deleted' THEN previous END,
           'by_member', by_member
         ))
  FROM unnest(events) WITH ORDINALITY AS e(name, ord)
  WHERE golive_plugin_event_subscribed(e.name)
  ORDER BY e.ord
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "reader_comments_plugin_events"
AFTER INSERT OR DELETE OR UPDATE OF status, removed_at ON "reader_comments"
FOR EACH ROW
EXECUTE PROCEDURE golive_reader_comment_plugin_events();
