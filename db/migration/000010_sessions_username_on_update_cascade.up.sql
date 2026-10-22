-- sessions.username references users.username with the default NO ACTION, so
-- renaming a user who has any session (every signed-in user) failed with a
-- foreign key violation. Follow the rename instead (issue #168).
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_username_fkey";
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_username_fkey"
  FOREIGN KEY ("username") REFERENCES "users" ("username") ON UPDATE CASCADE;
