-- Add slug column to posts table
ALTER TABLE posts ADD COLUMN slug varchar;

-- Backfill slug from existing url column (extract last path segment after /posts/)
UPDATE posts 
SET slug = regexp_replace(url, '^.*/posts/', '')
WHERE url IS NOT NULL AND url != '';

-- For any posts where slug is still null, generate from title
UPDATE posts
SET slug = lower(regexp_replace(regexp_replace(title, '[^a-zA-Z0-9]+', '-', 'g'), '(^-|-$)', '', 'g'))
WHERE slug IS NULL OR slug = '';

-- Make slug required and unique
ALTER TABLE posts ALTER COLUMN slug SET NOT NULL;
CREATE UNIQUE INDEX idx_posts_slug ON posts(slug);

-- Create settings table (typed core settings)
CREATE TABLE settings (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- Singleton row
  post_url_structure varchar NOT NULL DEFAULT 'id' CHECK (post_url_structure IN ('id', 'slug')),
  site_title varchar DEFAULT 'Go Live CMS',
  posts_per_page int DEFAULT 10 CHECK (posts_per_page > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_at timestamptz NOT NULL DEFAULT now()
);

-- Insert default settings
INSERT INTO settings (id, post_url_structure, site_title, posts_per_page) 
VALUES (1, 'id', 'Go Live CMS', 10);

-- Create extension_settings table (key-value for plugins/themes)
CREATE TABLE extension_settings (
  key varchar PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  extension_type varchar NOT NULL CHECK (extension_type IN ('plugin', 'theme')),
  extension_id varchar NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_at timestamptz NOT NULL DEFAULT now()
);

-- Index for efficient lookups by extension
CREATE INDEX idx_extension_settings_ext ON extension_settings(extension_type, extension_id);
