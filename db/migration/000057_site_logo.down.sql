-- The site logo leaves the settings (#488).
BEGIN;

ALTER TABLE settings DROP COLUMN site_logo_media_id;

COMMIT;