-- Scheduled publishing (issue #147).
--
-- A draft can be scheduled to publish at a time: post_status 'scheduled' and
-- publish_at (stored in UTC, like every timestamptz). The API's scheduler
-- (api/scheduled_publish.go) publishes it through the same path as the Publish
-- button: collab flush, then PublishPostTx (a version, post_status 'published').
-- Unscheduling returns the post to 'draft' and clears publish_at.
--
-- publish_scheduled_by: who scheduled it; the version's created_by.
-- publish_attempts: claims so far, for the retry backoff.
-- publish_next_attempt_at: not before then. A replica's claim sets it to the
--   end of its lease (so the other replicas skip the post), a failure to the
--   next retry. The claim's value is also its fencing token: the publish only
--   goes ahead while the row still holds it (a reschedule or cancel clears it).
-- publish_failed_at / publish_error: the last failed attempt, shown in the
--   editor ("Scheduled publish failed") until the post publishes or the
--   schedule changes. publish_error is a reason code, never an error text.
ALTER TABLE posts
    ADD COLUMN publish_at timestamptz,
    ADD COLUMN publish_scheduled_by bigint REFERENCES users (id) ON DELETE SET NULL,
    ADD COLUMN publish_attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN publish_next_attempt_at timestamptz,
    ADD COLUMN publish_failed_at timestamptz,
    ADD COLUMN publish_error varchar(64);

-- A scheduled post always has its time, and no other post has one, so a status
-- change that forgets to clear it fails loudly instead of leaving a stale time.
ALTER TABLE posts
    ADD CONSTRAINT posts_publish_at_scheduled CHECK ((post_status = 'scheduled') = (publish_at IS NOT NULL));

-- The scheduler's lookup: due scheduled posts only.
CREATE INDEX idx_posts_scheduled_publish_at ON posts (publish_at) WHERE post_status = 'scheduled';
