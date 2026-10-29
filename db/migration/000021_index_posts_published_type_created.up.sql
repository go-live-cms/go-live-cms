-- #351: older/newer posts and the related-posts fallback walk the published posts of
-- one type by (created_at, id). Partial, so drafts never enter it.
-- CONCURRENTLY keeps writes flowing during the build; it cannot run in a
-- transaction, so this file must stay a single statement.
CREATE INDEX CONCURRENTLY idx_posts_published_type_created_id ON posts (post_type, created_at, id) WHERE post_status = 'published';
