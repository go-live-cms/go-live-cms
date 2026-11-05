DROP TRIGGER IF EXISTS "posts_resolve_review_on_publish" ON "posts";
DROP FUNCTION IF EXISTS golive_resolve_review_on_publish();
-- The events stay with the rest of the activity log; only the requests go.
DROP TABLE IF EXISTS "review_requests";
