ALTER TABLE settings
  DROP COLUMN IF EXISTS editor_allowed_embeds,
  DROP COLUMN IF EXISTS editor_markdown_shortcuts,
  DROP COLUMN IF EXISTS date_format,
  DROP COLUMN IF EXISTS site_timezone,
  DROP COLUMN IF EXISTS site_language,
  DROP COLUMN IF EXISTS site_tagline;
