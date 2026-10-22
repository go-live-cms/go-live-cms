-- #131: serves the admin list sorted by changed_at (#89). The list queries sort
-- by GREATEST(changed_at, created_at) so never-updated posts (sentinel
-- 0001-01-01) rank by creation time; the index uses the same expression.
CREATE INDEX CONCURRENTLY idx_posts_changed_at_id ON posts ((GREATEST(changed_at, created_at)) DESC, id DESC);
