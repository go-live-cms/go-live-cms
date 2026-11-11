-- Reverts 000054. Activity rows about plugins (object_type 'plugin') stay: activity
-- has no foreign key to its objects, and the feed shows a removed object generically.
DROP TABLE IF EXISTS "plugins";
