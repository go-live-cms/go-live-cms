ALTER TABLE "posts" DROP CONSTRAINT IF EXISTS "posts_post_parent_fkey";
ALTER TABLE "post_meta" DROP CONSTRAINT IF EXISTS "post_meta_post_id_fkey";
ALTER TABLE "posts_taxonomies" DROP CONSTRAINT IF EXISTS "posts_taxonomies_post_id_fkey";
ALTER TABLE "user_posts" DROP CONSTRAINT IF EXISTS "user_posts_post_id_fkey";
ALTER TABLE "user_posts" DROP CONSTRAINT IF EXISTS "user_posts_user_id_fkey";
ALTER TABLE "posts_taxonomies" DROP CONSTRAINT IF EXISTS "posts_taxonomies_taxonomy_id_fkey";
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_username_fkey";
ALTER TABLE "post_media" DROP CONSTRAINT IF EXISTS "post_media_post_id_fkey";
ALTER TABLE "post_media" DROP CONSTRAINT IF EXISTS "post_media_media_id_fkey";
ALTER TABLE "media" DROP CONSTRAINT IF EXISTS "media_user_id_fkey";

DROP INDEX IF EXISTS "unique_post_user";
DROP INDEX IF EXISTS "unique_post_taxonomy";
DROP INDEX IF EXISTS "unique_post_media";
DROP INDEX IF EXISTS "idx_posts_type";
DROP INDEX IF EXISTS "idx_posts_status";
DROP INDEX IF EXISTS "idx_posts_parent";
DROP INDEX IF EXISTS "idx_post_meta_post_id";
DROP INDEX IF EXISTS "idx_post_meta_key";
DROP INDEX IF EXISTS "idx_post_meta_key_value";

DROP TABLE IF EXISTS "post_meta";
DROP TABLE IF EXISTS "post_media";
DROP TABLE IF EXISTS "posts_taxonomies";
DROP TABLE IF EXISTS "user_posts";
DROP TABLE IF EXISTS "sessions";

DROP TABLE IF EXISTS "posts";
DROP TABLE IF EXISTS "post_types";
DROP TABLE IF EXISTS "media";
DROP TABLE IF EXISTS "taxonomies";
DROP TABLE IF EXISTS "users";