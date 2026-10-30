-- Author profile fields (issue #350): a short plain-text bio and a personal
-- website, shown on the public author page and the post's "Written by" cards.
--
-- Empty string = not set. The API validates both (bio at most 300 characters,
-- website an http(s) URL); the CHECKs are the backstop for the length.
ALTER TABLE "users"
  ADD COLUMN "bio" varchar NOT NULL DEFAULT '',
  ADD COLUMN "website" varchar NOT NULL DEFAULT '',
  ADD CONSTRAINT "users_bio_length_check" CHECK (char_length("bio") <= 300),
  ADD CONSTRAINT "users_website_length_check" CHECK (char_length("website") <= 2048);
