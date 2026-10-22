ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_username_fkey";
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_username_fkey"
  FOREIGN KEY ("username") REFERENCES "users" ("username");
