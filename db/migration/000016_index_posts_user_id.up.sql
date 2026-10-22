-- #131: author filter counts and a user's post list.
CREATE INDEX CONCURRENTLY idx_posts_user_id ON posts (user_id);
