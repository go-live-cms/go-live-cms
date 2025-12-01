-- Remove the legacy content column from posts table
ALTER TABLE posts DROP COLUMN IF EXISTS content;
