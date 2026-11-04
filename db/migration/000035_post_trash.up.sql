-- Trash (issue #327).
--
-- Deleting a post moves it to the trash instead of removing the row: post_status
-- 'trash', deleted_at (when) and trashed_from_status (the status it had, which
-- restoring brings back). Permanent delete, from the trash only, is the old hard
-- delete.
--
-- A status rather than a flag on purpose: every public read already requires
-- post_status = 'published' (the post page, /public lists, feeds, the sitemap,
-- search, term and author archives, related and adjacent posts, menus), the
-- scheduler claims post_status = 'scheduled' only, and the admin's lists filter by
-- status. A trashed post drops out of all of them without each query having to
-- remember a deleted_at check. Its published snapshot (published_block_doc,
-- published_settings) stays, so restoring a published post puts the same content
-- back on the site.
--
-- A trashed scheduled post keeps publish_at (and who scheduled it), so restoring it
-- before that time schedules it again; after it, restoring makes it a draft.
ALTER TABLE posts
    ADD COLUMN deleted_at timestamptz,
    ADD COLUMN trashed_from_status varchar(32);

-- Both are set exactly while the post is in the trash.
ALTER TABLE posts
    ADD CONSTRAINT posts_trash_state CHECK (
        (post_status = 'trash') = (deleted_at IS NOT NULL)
        AND (post_status = 'trash') = (trashed_from_status IS NOT NULL)
        AND trashed_from_status IS DISTINCT FROM 'trash'
    );

-- 000033's rule, plus the one exception: a scheduled post in the trash keeps its time.
ALTER TABLE posts DROP CONSTRAINT posts_publish_at_scheduled;
ALTER TABLE posts
    ADD CONSTRAINT posts_publish_at_scheduled CHECK (
        (post_status = 'scheduled') = (publish_at IS NOT NULL)
        OR (post_status = 'trash' AND trashed_from_status = 'scheduled' AND publish_at IS NOT NULL)
    );

-- The Trash tab, newest first.
CREATE INDEX idx_posts_trash_deleted_at ON posts (deleted_at) WHERE post_status = 'trash';
