-- #131: serves the admin list sorted by changed_at (#89).
CREATE INDEX idx_posts_changed_at_id ON posts (changed_at DESC, id DESC);
