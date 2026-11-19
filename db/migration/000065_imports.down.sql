-- Imported redirects are kept as manual ones: they still answer old links.
UPDATE "redirects" SET "source" = 'manual' WHERE "source" = 'import';
ALTER TABLE "redirects" DROP CONSTRAINT "redirects_source";
ALTER TABLE "redirects" ADD CONSTRAINT "redirects_source"
  CHECK ("source" IN ('manual', 'post', 'term', 'merge'));

DROP TABLE IF EXISTS "import_media";
DROP TABLE IF EXISTS "import_files";
DROP TABLE IF EXISTS "import_items";
DROP TABLE IF EXISTS "import_jobs";
