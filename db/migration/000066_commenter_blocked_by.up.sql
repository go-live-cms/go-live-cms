-- Reader comments, moderation (#526, docs/design/reader-comments.md 5.5, 6.1, 16.1).
--
-- The commenter page shows who blocked an address and when (the #521 boards: "Blocked by
-- Ana Costa on Nov 17"), so commenters gains blocked_by beside blocked_at. A member
-- removed later leaves the block in place, unattributed. Unblocking clears both.
ALTER TABLE commenters
  ADD COLUMN blocked_by bigint REFERENCES users (id) ON DELETE SET NULL,
  ADD CONSTRAINT commenters_blocked_by CHECK (blocked_by IS NULL OR blocked_at IS NOT NULL);
