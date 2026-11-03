ALTER TABLE "post_versions" DROP CONSTRAINT "post_versions_created_by_fkey";
ALTER TABLE "post_versions" ADD CONSTRAINT "post_versions_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users" ("id");

ALTER TABLE "users" DROP COLUMN "last_active_at";
