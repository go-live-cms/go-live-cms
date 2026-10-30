-- #330: the General and Editor settings of the Settings page. The value lists (languages,
-- time zones, embed providers) are checked by the API (settings_utils.go), where they can
-- grow without a migration; only the fixed presets and the length are checked here too.
ALTER TABLE settings
  ADD COLUMN site_tagline varchar NOT NULL DEFAULT '' CHECK (char_length(site_tagline) <= 160),
  ADD COLUMN site_language varchar NOT NULL DEFAULT 'en-US',
  ADD COLUMN site_timezone varchar NOT NULL DEFAULT 'UTC',
  ADD COLUMN date_format varchar NOT NULL DEFAULT 'month_day_year' CHECK (date_format IN ('month_day_year', 'day_month_year', 'iso')),
  ADD COLUMN editor_markdown_shortcuts boolean NOT NULL DEFAULT true,
  ADD COLUMN editor_allowed_embeds text[] NOT NULL DEFAULT '{youtube,vimeo}';
