-- #330: the General and Editor settings of the Settings page. The value lists (languages,
-- time zones, embed providers) are checked by the API (settings_utils.go), where they can
-- grow without a migration; only the fixed presets and the length are checked here too.
BEGIN;

ALTER TABLE settings
  ADD COLUMN site_tagline varchar NOT NULL DEFAULT '' CHECK (char_length(site_tagline) <= 160),
  ADD COLUMN site_language varchar NOT NULL DEFAULT 'en-US',
  ADD COLUMN site_timezone varchar NOT NULL DEFAULT 'UTC',
  ADD COLUMN date_format varchar NOT NULL DEFAULT 'month_day_year' CHECK (date_format IN ('month_day_year', 'day_month_year', 'iso')),
  ADD COLUMN editor_markdown_shortcuts boolean NOT NULL DEFAULT true,
  ADD COLUMN editor_allowed_embeds text[] NOT NULL DEFAULT '{youtube,vimeo}';

-- Search (#145) follows the site language: each supported language's Postgres text
-- search configuration (stemming and stop words), 'simple' for anything else. The tags
-- are the API's siteLanguages; api/settings_site_test.go fails if they differ.
CREATE FUNCTION golive_search_config_for(language text) RETURNS regconfig
LANGUAGE sql STABLE AS $$
  SELECT (CASE language
    WHEN 'en-US' THEN 'english'
    WHEN 'en-GB' THEN 'english'
    WHEN 'pt-BR' THEN 'portuguese'
    WHEN 'pt-PT' THEN 'portuguese'
    WHEN 'es-ES' THEN 'spanish'
    WHEN 'fr-FR' THEN 'french'
    WHEN 'de-DE' THEN 'german'
    WHEN 'it-IT' THEN 'italian'
    WHEN 'nl-NL' THEN 'dutch'
    ELSE 'simple'
  END)::regconfig
$$;

-- Replaces 000024's 'simple': the configuration of the stored language.
CREATE OR REPLACE FUNCTION golive_search_config() RETURNS regconfig
LANGUAGE sql STABLE AS $$
  SELECT golive_search_config_for((SELECT site_language FROM settings WHERE id = 1))
$$;

-- A stored document built with one configuration doesn't match queries parsed with
-- another, so a language change that changes the configuration reindexes every post, in
-- the settings update's transaction (en-US -> en-GB doesn't).
CREATE FUNCTION golive_settings_search_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM golive_refresh_post_search(ARRAY(SELECT id FROM posts));
  RETURN NULL;
END
$$;

CREATE TRIGGER settings_search_language
  AFTER UPDATE OF site_language ON settings
  FOR EACH ROW
  WHEN (golive_search_config_for(OLD.site_language) IS DISTINCT FROM golive_search_config_for(NEW.site_language))
  EXECUTE FUNCTION golive_settings_search_trigger();

-- Existing documents were built with 'simple'; the default language is en-US (english).
SELECT golive_refresh_post_search(ARRAY(SELECT id FROM posts));

COMMIT;
