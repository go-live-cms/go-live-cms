-- Reverts 000055. The outbox goes with its trigger: runs not yet made are lost, which
-- is what turning hooks off means. The plugin_hook_failed activity rows stay; they
-- describe plugins (000054), which remain.
DROP TRIGGER IF EXISTS "posts_plugin_events" ON "posts";
DROP FUNCTION IF EXISTS golive_post_plugin_events();
DROP FUNCTION IF EXISTS golive_plugin_event_subscribed(text);
DROP TABLE IF EXISTS "plugin_hook_runs";
DROP TABLE IF EXISTS "plugin_events";
