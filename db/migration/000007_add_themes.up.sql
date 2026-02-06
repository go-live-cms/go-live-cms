-- Create themes table
CREATE TABLE themes (
  id BIGSERIAL PRIMARY KEY,
  name varchar NOT NULL,
  slug varchar UNIQUE NOT NULL,
  description varchar DEFAULT '',
  version varchar NOT NULL DEFAULT '1.0.0',
  author varchar DEFAULT '',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_at timestamptz NOT NULL DEFAULT now()
);

-- Create unique partial index to ensure only one active theme
CREATE UNIQUE INDEX idx_themes_active ON themes(active) WHERE active = true;

-- Create theme_settings table for per-theme customizations
CREATE TABLE theme_settings (
  id BIGSERIAL PRIMARY KEY,
  theme_id bigint NOT NULL,
  setting_key varchar NOT NULL,
  setting_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_theme FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE CASCADE
);

-- Create unique index for theme_id + setting_key
CREATE UNIQUE INDEX idx_theme_settings_theme_key ON theme_settings(theme_id, setting_key);

-- Index for efficient lookups
CREATE INDEX idx_theme_settings_theme_id ON theme_settings(theme_id);

-- Insert default theme
INSERT INTO themes (name, slug, description, version, author, active, config)
VALUES (
  'Default',
  'default',
  'Default Go Live CMS theme with multiple layout variants',
  '1.0.0',
  'Go Live CMS',
  true,
  '{
    "layouts": {
      "post": {
        "default": "default",
        "variants": ["default", "sidebar", "wide"]
      },
      "page": {
        "default": "default",
        "variants": ["default", "fullwidth"]
      }
    }
  }'::jsonb
);

-- Insert default theme settings (layout variants)
INSERT INTO theme_settings (theme_id, setting_key, setting_value)
SELECT 
  id,
  'layout_variants',
  '{
    "post": "default",
    "page": "default"
  }'::jsonb
FROM themes WHERE slug = 'default';
