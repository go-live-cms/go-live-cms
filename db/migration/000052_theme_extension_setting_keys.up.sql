-- #451: every theme row's key becomes theme:<slug>:<key>. `key` alone is the
-- primary key, so a bare key is shared between themes.
--
-- Two old shapes exist: <slug>:<key>, which ThemeSettingsImpl's get and delete
-- read, and the bare key its set wrote. The first goes first, so a theme that
-- holds both keeps the value get could read; a bare row whose new key is
-- already taken stays as it is, unread, as it always was. An extension_id with
-- a colon can't be a theme slug and is left alone: two rows could map to one key.

UPDATE extension_settings AS old
SET key = 'theme:' || old.extension_id || ':' || substr(old.key, length(old.extension_id) + 2)
WHERE old.extension_type = 'theme'
  AND position(':' IN old.extension_id) = 0
  AND left(old.key, length(old.extension_id) + 1) = old.extension_id || ':'
  AND NOT EXISTS (
    SELECT 1 FROM extension_settings AS taken
    WHERE taken.key = 'theme:' || old.extension_id || ':' || substr(old.key, length(old.extension_id) + 2)
  );

UPDATE extension_settings AS bare
SET key = 'theme:' || bare.extension_id || ':' || bare.key
WHERE bare.extension_type = 'theme'
  AND position(':' IN bare.extension_id) = 0
  AND bare.key NOT LIKE 'theme:%'
  AND NOT EXISTS (
    SELECT 1 FROM extension_settings AS taken
    WHERE taken.key = 'theme:' || bare.extension_id || ':' || bare.key
  );
