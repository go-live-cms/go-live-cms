ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_publish_at_scheduled;
DROP INDEX IF EXISTS idx_posts_scheduled_publish_at;

-- Scheduled posts go back to draft: the older code has no 'scheduled' status.
UPDATE posts SET post_status = 'draft' WHERE post_status = 'scheduled';

ALTER TABLE posts
    DROP COLUMN IF EXISTS publish_error,
    DROP COLUMN IF EXISTS publish_failed_at,
    DROP COLUMN IF EXISTS publish_next_attempt_at,
    DROP COLUMN IF EXISTS publish_attempts,
    DROP COLUMN IF EXISTS publish_scheduled_by,
    DROP COLUMN IF EXISTS publish_at;
