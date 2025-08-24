-- Drop constraints first (new ones for taxonomy system)
ALTER TABLE "taxonomy_terms" DROP CONSTRAINT IF EXISTS "taxonomy_terms_parent_id_fkey";
ALTER TABLE "taxonomy_terms" DROP CONSTRAINT IF EXISTS "taxonomy_terms_taxonomy_type_id_fkey";
ALTER TABLE "post_taxonomy_relationships" DROP CONSTRAINT IF EXISTS "post_taxonomy_relationships_post_id_fkey";
ALTER TABLE "post_taxonomy_relationships" DROP CONSTRAINT IF EXISTS "post_taxonomy_relationships_taxonomy_term_id_fkey";

-- Drop existing constraints
ALTER TABLE "posts" DROP CONSTRAINT IF EXISTS "posts_post_parent_fkey";
ALTER TABLE "post_meta" DROP CONSTRAINT IF EXISTS "post_meta_post_id_fkey";
ALTER TABLE "user_posts" DROP CONSTRAINT IF EXISTS "user_posts_post_id_fkey";
ALTER TABLE "user_posts" DROP CONSTRAINT IF EXISTS "user_posts_user_id_fkey";
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_username_fkey";
ALTER TABLE "post_media" DROP CONSTRAINT IF EXISTS "post_media_post_id_fkey";
ALTER TABLE "post_media" DROP CONSTRAINT IF EXISTS "post_media_media_id_fkey";
ALTER TABLE "media" DROP CONSTRAINT IF EXISTS "media_user_id_fkey";

-- Drop unique constraints
ALTER TABLE "post_meta" DROP CONSTRAINT IF EXISTS "unique_post_meta_key";

-- Drop indexes (new taxonomy indexes)
DROP INDEX IF EXISTS "idx_taxonomy_terms_type";
DROP INDEX IF EXISTS "idx_taxonomy_terms_parent";
DROP INDEX IF EXISTS "idx_taxonomy_terms_slug";
DROP INDEX IF EXISTS "unique_post_taxonomy_term";

-- Drop existing indexes
DROP INDEX IF EXISTS "unique_post_user";
DROP INDEX IF EXISTS "unique_post_media";
DROP INDEX IF EXISTS "idx_posts_type";
DROP INDEX IF EXISTS "idx_posts_status";
DROP INDEX IF EXISTS "idx_posts_parent";
DROP INDEX IF EXISTS "idx_post_meta_post_id";
DROP INDEX IF EXISTS "idx_post_meta_key";
DROP INDEX IF EXISTS "idx_post_meta_key_value";

-- Drop tables in correct order (child tables first)
DROP TABLE IF EXISTS "post_taxonomy_relationships";
DROP TABLE IF EXISTS "taxonomy_terms";
DROP TABLE IF EXISTS "taxonomy_types";
DROP TABLE IF EXISTS "post_meta";
DROP TABLE IF EXISTS "post_media";
DROP TABLE IF EXISTS "user_posts";
DROP TABLE IF EXISTS "sessions";

-- Now safe to drop parent tables
DROP TABLE IF EXISTS "posts";
DROP TABLE IF EXISTS "post_types";
DROP TABLE IF EXISTS "media";
DROP TABLE IF EXISTS "users";