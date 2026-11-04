-- Pending scheduled updates are dropped: the older code can't apply them, and the
-- live posts stay as they are (their working copies keep the changes).
DROP TRIGGER IF EXISTS posts_cancel_scheduled_update ON posts;
DROP FUNCTION IF EXISTS golive_cancel_scheduled_update_trigger();
DROP TABLE IF EXISTS post_scheduled_updates;
