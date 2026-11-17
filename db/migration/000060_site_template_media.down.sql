-- Reverts 000060. Only the "Used in" index of templates and parts goes: the templates, their
-- docs and the media are untouched, and the next store or publish after re-applying 000060
-- rebuilds the rows (its backfill does too).
DROP TABLE IF EXISTS "site_template_media";
