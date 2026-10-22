-- #131: serves the default post list order (created_at, id tiebreaker) for every type/status filter, incl. the public published list.
-- CONCURRENTLY keeps writes flowing during the build; it cannot run in a
-- transaction, so this file must stay a single statement.
CREATE INDEX CONCURRENTLY idx_posts_created_at_id ON posts (created_at DESC, id DESC);
