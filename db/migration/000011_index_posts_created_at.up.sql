-- #131: serves the default post list order (created_at, id tiebreaker) for every type/status filter, incl. the public published list.
CREATE INDEX idx_posts_created_at_id ON posts (created_at DESC, id DESC);
