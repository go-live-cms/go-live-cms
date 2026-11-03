-- Users screen (#333): when each member was last active, and removal that keeps history.

-- Set by authenticated requests, login and refresh-token rotation, at most once per
-- LAST_ACTIVE_INTERVAL (TouchUserLastActive). NULL = not active since this column was added.
ALTER TABLE "users" ADD COLUMN "last_active_at" timestamptz NULL;

-- A removed member's revisions stay; they just no longer name who published them. The
-- FK had no ON DELETE, so removing anyone who had ever published failed.
ALTER TABLE "post_versions" DROP CONSTRAINT "post_versions_created_by_fkey";
ALTER TABLE "post_versions" ADD CONSTRAINT "post_versions_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE SET NULL;
