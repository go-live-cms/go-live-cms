DROP INDEX IF EXISTS idx_posts_trash_deleted_at;
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_trash_state;
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_publish_at_scheduled;

-- The older code has no trash. Trashed posts become archived, not restored: they stay
-- off the site and out of All, and nothing is deleted. A trashed scheduled post loses
-- its time (000033's CHECK allows a time on scheduled posts only).
UPDATE posts
SET post_status = 'archived',
    publish_at = NULL,
    publish_scheduled_by = NULL,
    publish_attempts = 0,
    publish_next_attempt_at = NULL,
    publish_failed_at = NULL,
    publish_error = NULL
WHERE post_status = 'trash';

ALTER TABLE posts
    ADD CONSTRAINT posts_publish_at_scheduled CHECK ((post_status = 'scheduled') = (publish_at IS NOT NULL));

ALTER TABLE posts
    DROP COLUMN IF EXISTS trashed_from_status,
    DROP COLUMN IF EXISTS deleted_at;
