-- The site logo (#488, docs/design/theme-builder.md 4.1).
--
-- settings.site_logo_media_id is the image Settings > General picks: the Site logo block
-- shows it, and GET /settings returns it with its media (site_logo). NULL = none, so the
-- block renders nothing. The API only accepts an image; deleting the media clears it
-- (ON DELETE SET NULL), and the block then renders nothing too.
BEGIN;

ALTER TABLE settings
  ADD COLUMN site_logo_media_id bigint NULL REFERENCES media (id) ON DELETE SET NULL;

COMMIT;