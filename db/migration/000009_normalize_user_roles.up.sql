-- Normalize user roles to the admin/editor/contributor taxonomy (issue #187).
-- Previous values were a mix of 'User' (schema default), 'user', 'admin',
-- 'moderator', and dev-seeded 'author'. The CASE catch-all maps anything
-- unrecognized to 'contributor' (lowest privilege).
-- No CHECK constraint on purpose: custom admin-defined roles are planned;
-- validation lives at the API binding layer (later: a roles table).
UPDATE "users" SET "role" = CASE
  WHEN lower("role") = 'admin' THEN 'admin'
  WHEN lower("role") IN ('editor', 'moderator') THEN 'editor'
  ELSE 'contributor'
END;

ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'contributor';
