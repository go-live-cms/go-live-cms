ALTER TABLE "users"
  DROP CONSTRAINT IF EXISTS "users_website_length_check",
  DROP CONSTRAINT IF EXISTS "users_bio_length_check",
  DROP COLUMN IF EXISTS "website",
  DROP COLUMN IF EXISTS "bio";
