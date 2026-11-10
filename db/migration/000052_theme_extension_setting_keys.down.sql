-- Back to <slug>:<key>, the only shape the old get and delete could read. A row
-- that was bare before the up migration comes back in this shape too: bare keys
-- were never read, and bringing them back could collide between themes.

UPDATE extension_settings AS namespaced
SET key = substr(namespaced.key, length('theme:') + 1)
WHERE namespaced.extension_type = 'theme'
  AND position(':' IN namespaced.extension_id) = 0
  AND left(namespaced.key, length('theme:' || namespaced.extension_id || ':')) = 'theme:' || namespaced.extension_id || ':'
  AND NOT EXISTS (
    SELECT 1 FROM extension_settings AS taken
    WHERE taken.key = substr(namespaced.key, length('theme:') + 1)
  );
