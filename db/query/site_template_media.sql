-- "Used in" for media in templates and parts (#496, 000063, docs/design/theme-builder.md 5.6).

-- name: SyncSiteTemplateMedia :exec
-- Makes one copy's rows of a template (published = false: the working copy, true: the
-- published one) match its doc's media blocks. The three arrays are parallel, one entry per
-- block: media_ids[i] is shown by block block_ids[i] of type block_types[i]. Ids without a
-- media row are skipped (a stale mediaId must not fail the store or the publish), as
-- SyncPostContentMedia does. Rows no longer wanted go; the others are inserted or keep
-- their row with the block's current type.
WITH uses AS (
    SELECT u.media_id, b.block_id, t.block_type
    FROM unnest(@media_ids::bigint[]) WITH ORDINALITY AS u(media_id, ord)
    JOIN unnest(@block_ids::text[]) WITH ORDINALITY AS b(block_id, ord) ON b.ord = u.ord
    JOIN unnest(@block_types::text[]) WITH ORDINALITY AS t(block_type, ord) ON t.ord = u.ord
), wanted AS (
    SELECT DISTINCT ON (uses.media_id, uses.block_id) uses.media_id, uses.block_id, uses.block_type
    FROM uses
    JOIN media m ON m.id = uses.media_id
    ORDER BY uses.media_id, uses.block_id
), removed AS (
    DELETE FROM site_template_media stm
    WHERE stm.template_id = @template_id
      AND stm.published = @published
      AND NOT EXISTS (
          SELECT 1 FROM wanted w WHERE w.media_id = stm.media_id AND w.block_id = stm.block_id
      )
)
INSERT INTO site_template_media (template_id, media_id, block_id, block_type, published)
SELECT @template_id, wanted.media_id, wanted.block_id, wanted.block_type, @published
FROM wanted
ON CONFLICT (template_id, published, media_id, block_id) DO UPDATE
SET block_type = EXCLUDED.block_type
WHERE site_template_media.block_type IS DISTINCT FROM EXCLUDED.block_type;

-- name: ListSiteTemplatesByMedia :many
-- GET /media/:id/posts' site_templates: every template or part of any theme whose working
-- or published copy shows the media, one row per block and copy (the handler groups them).
-- theme_active: the row's theme is the active one, so its published copy is on the site.
SELECT t.id, t.theme_slug, t.kind, t.slug, t.title,
       stm.block_id, stm.block_type, stm.published,
       EXISTS (SELECT 1 FROM themes th WHERE th.slug = t.theme_slug AND th.active) AS theme_active
FROM site_template_media stm
JOIN site_templates t ON t.id = stm.template_id
WHERE stm.media_id = sqlc.arg('media_id')::bigint
ORDER BY theme_active DESC, t.theme_slug, t.kind DESC, t.slug, t.id, stm.published DESC, stm.block_id;

-- name: ListSiteTemplatesByCaptionsMedia :many
-- The same for a captions file (#507): it is in no block itself, so these are the templates
-- and parts showing a video it captions, with that video's video blocks.
SELECT t.id, t.theme_slug, t.kind, t.slug, t.title,
       stm.block_id, stm.block_type, stm.published,
       EXISTS (SELECT 1 FROM themes th WHERE th.slug = t.theme_slug AND th.active) AS theme_active
FROM media v
JOIN site_template_media stm ON stm.media_id = v.id
JOIN site_templates t ON t.id = stm.template_id
WHERE v.captions_media_id = sqlc.arg('captions_media_id')::bigint
  AND stm.block_type = 'video'
ORDER BY theme_active DESC, t.theme_slug, t.kind DESC, t.slug, t.id, stm.published DESC, stm.block_id;

-- name: ListSiteTemplateMedia :many
-- One template's rows (tests and the publish's checks).
SELECT * FROM site_template_media
WHERE template_id = $1
ORDER BY published DESC, media_id, block_id;
