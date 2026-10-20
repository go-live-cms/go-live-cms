-- Revert to the pre-#187 role taxonomy. Lossy by nature: rows that were
-- 'author' or 'User'/'user' before the up migration all come back as 'User',
-- the original schema default, so a rolled-back table holds one spelling.
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'User';

UPDATE "users" SET "role" = CASE
  WHEN "role" = 'editor' THEN 'moderator'
  WHEN "role" = 'contributor' THEN 'User'
  ELSE "role"
END;
