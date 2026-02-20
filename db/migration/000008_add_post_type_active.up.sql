-- Add is_active column to post_types for theme-owned post type visibility
ALTER TABLE "post_types" ADD COLUMN "is_active" boolean NOT NULL DEFAULT true;

-- Add registered_by to track origin: 'system' for built-in, 'theme:slug' for theme-registered
ALTER TABLE "post_types" ADD COLUMN "registered_by" varchar NOT NULL DEFAULT 'system';
