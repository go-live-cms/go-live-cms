-- #131: media usage counts and media deletes (the unique index leads with post_id).
CREATE INDEX CONCURRENTLY idx_post_media_media_id ON post_media (media_id);
