DROP TABLE IF EXISTS "email_change_tokens";

ALTER TABLE "users" DROP COLUMN IF EXISTS "avatar_url";
