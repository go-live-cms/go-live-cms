-- #131: serves the post list sorted by title (#89); scanned backward for desc.
CREATE INDEX idx_posts_title_id ON posts (title, id);
