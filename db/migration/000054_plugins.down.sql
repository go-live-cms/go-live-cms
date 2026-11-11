-- Reverts 000054. The plugin events go too: a later up restarts plugins.id, and the
-- feed would attach old events to whichever new plugin got the same id.
DELETE FROM "activity" WHERE "object_type" = 'plugin';
DROP TABLE IF EXISTS "plugins";
