-- Captions for videos (#507, WCAG 1.2.2, split out of #481).
--
-- A video block stores only its media id, so the captions belong to the media item: a
-- video's captions_media_id is the WebVTT file (a text/vtt media item) the public video
-- block renders as <track kind="captions">. Replacing that file or the video reaches every
-- post without republishing. captions_lang is the track's srclang (a BCP-47 tag): the API
-- stores the site language when PUT /media/:id sets captions without one; '' only on a row
-- without captions. Deleting the captions file clears captions_media_id (ON DELETE SET
-- NULL); deleting the video leaves the captions file in the library.
BEGIN;

ALTER TABLE media
  ADD COLUMN captions_media_id bigint NULL REFERENCES media (id) ON DELETE SET NULL,
  ADD COLUMN captions_lang text NOT NULL DEFAULT '',
  ADD CONSTRAINT media_captions_not_self CHECK (captions_media_id IS NULL OR captions_media_id <> id),
  ADD CONSTRAINT media_captions_lang_length CHECK (char_length(captions_lang) <= 35);

-- "Used in" for a captions file (the videos it captions) and the ON DELETE SET NULL scan.
CREATE INDEX media_captions_media_id_idx ON media (captions_media_id) WHERE captions_media_id IS NOT NULL;

COMMIT;
