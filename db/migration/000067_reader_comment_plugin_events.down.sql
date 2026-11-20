-- Undoes 000067: reader comments stop writing plugin events. Comment events already in
-- the outbox stay until they're run or pruned.
DROP TRIGGER IF EXISTS "reader_comments_plugin_events" ON "reader_comments";
DROP FUNCTION IF EXISTS golive_reader_comment_plugin_events();
