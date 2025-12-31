-- Drop extension_settings table
DROP TABLE IF EXISTS extension_settings;

-- Drop settings table
DROP TABLE IF EXISTS settings;

-- Remove slug column from posts
DROP INDEX IF EXISTS idx_posts_slug;
ALTER TABLE posts DROP COLUMN IF EXISTS slug;
