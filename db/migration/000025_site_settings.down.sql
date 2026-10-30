BEGIN;

DROP TRIGGER IF EXISTS settings_search_language ON settings;
DROP FUNCTION IF EXISTS golive_settings_search_trigger();

-- Back to 000024's definition before the column it reads goes away, then rebuild the
-- documents with it.
CREATE OR REPLACE FUNCTION golive_search_config() RETURNS regconfig
LANGUAGE sql STABLE AS $$
  SELECT 'simple'::regconfig
$$;
DROP FUNCTION IF EXISTS golive_search_config_for(text);
SELECT golive_refresh_post_search(ARRAY(SELECT id FROM posts));

ALTER TABLE settings
  DROP COLUMN IF EXISTS editor_allowed_embeds,
  DROP COLUMN IF EXISTS editor_markdown_shortcuts,
  DROP COLUMN IF EXISTS date_format,
  DROP COLUMN IF EXISTS site_timezone,
  DROP COLUMN IF EXISTS site_language,
  DROP COLUMN IF EXISTS site_tagline;

COMMIT;
