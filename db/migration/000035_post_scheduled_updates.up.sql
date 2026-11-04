-- Scheduled updates to published posts (issue #335).
--
-- A published post with changes not published (#326) can schedule its Update for a
-- time. Scheduling freezes the content: the API flushes the collab document (as
-- publish does) and copies the working copy's block_doc and settings
-- (golive_post_settings, #358) into this row. The working copy stays free to edit;
-- the live post stays as it is until the time. Then the scheduler
-- (api/scheduled_publish.go, the one #147 built) publishes exactly this snapshot as a
-- new version, never what the working copy holds by then. Scheduling again (the
-- dialog's Reschedule) takes a new snapshot.
--
-- One pending update per post (the primary key). The retry state mirrors #147's
-- publish_* columns on posts: attempts, next_attempt_at (the claim's lease and
-- fencing token, or the next retry), failed_at and error (a reason code).
CREATE TABLE post_scheduled_updates (
    post_id bigint PRIMARY KEY REFERENCES posts (id) ON DELETE CASCADE,
    update_at timestamptz NOT NULL,
    block_doc jsonb NOT NULL,
    settings jsonb NOT NULL,
    -- Who scheduled it: the version's created_by.
    scheduled_by bigint REFERENCES users (id) ON DELETE SET NULL,
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz,
    failed_at timestamptz,
    error varchar(64),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- The scheduler's lookup of due updates.
CREATE INDEX idx_post_scheduled_updates_update_at ON post_scheduled_updates (update_at);

-- A pending update belongs to the post as published now. Anything that changes that
-- ends it, in the same transaction:
--   - a new published version: Update by hand (a newer publish than the snapshot,
--     so applying the snapshot later would roll the site back), or the scheduled
--     update itself being applied;
--   - the post leaving 'published': unpublish, archive, trash, any status change.
-- A trigger rather than each writer, so a status change added later can't leave a
-- stale update behind to publish a post that is no longer live.
CREATE FUNCTION golive_cancel_scheduled_update_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM post_scheduled_updates WHERE post_id = NEW.id;
  RETURN NULL;
END
$$;

CREATE TRIGGER posts_cancel_scheduled_update
  AFTER UPDATE OF post_status, published_version_id ON posts
  FOR EACH ROW WHEN (
    OLD.post_status IS DISTINCT FROM NEW.post_status
    OR OLD.published_version_id IS DISTINCT FROM NEW.published_version_id
  )
  EXECUTE FUNCTION golive_cancel_scheduled_update_trigger();
