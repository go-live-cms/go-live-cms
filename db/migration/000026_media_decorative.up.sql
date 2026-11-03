-- Decorative images (issue #325).
--
-- Alt text became optional on upload, so an image can be stored without one.
-- decorative marks an image whose empty alt text is intended (a background, a
-- divider): the public site renders it with alt="" and the admin doesn't flag
-- it. "Missing alt text" is an image that is not decorative and whose alt is
-- empty or only whitespace (db/query/media.sql).
ALTER TABLE "media"
  ADD COLUMN "decorative" boolean NOT NULL DEFAULT false;
