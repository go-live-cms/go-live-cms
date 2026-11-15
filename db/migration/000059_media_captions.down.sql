-- Videos lose their captions (#507).
BEGIN;

DROP INDEX IF EXISTS media_captions_media_id_idx;

ALTER TABLE media
  DROP CONSTRAINT IF EXISTS media_captions_lang_length,
  DROP CONSTRAINT IF EXISTS media_captions_not_self,
  DROP COLUMN captions_lang,
  DROP COLUMN captions_media_id;

COMMIT;
