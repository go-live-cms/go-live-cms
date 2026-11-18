-- "Used in" for media in templates and parts (#496, docs/design/theme-builder.md 1.2
-- problem 3 and 5.6). Until now "Used in" and the media delete warning only knew posts
-- (post_media), so a logo or cover image in a header part could be deleted without a word.
--
-- One row per media block of a template or part, per copy: published = false for the
-- working copy (synced by every collab store, StoreSiteTemplateCollabTx), true for the
-- published copy (synced by each publish, PublishSiteDesignTx's hook; a reset publishes NULL
-- and leaves no published rows). block_type is the Block Spec type, as in post_media's
-- blocks, so "Used in" can say "Image block". Deleting the template or the media removes
-- its rows; a deleted media renders nothing in the part (the resolve route's
-- media_missing), as in posts.
CREATE TABLE "site_template_media" (
  "template_id" bigint  NOT NULL REFERENCES "site_templates" ("id") ON DELETE CASCADE,
  "media_id"    bigint  NOT NULL REFERENCES "media" ("id") ON DELETE CASCADE,
  "block_id"    text    NOT NULL,
  "block_type"  text    NOT NULL,
  "published"   boolean NOT NULL,
  PRIMARY KEY ("template_id", "published", "media_id", "block_id")
);

-- GET /media/:id/posts reads by media.
CREATE INDEX "site_template_media_media_id_idx" ON "site_template_media" ("media_id");

-- Backfill from what 000058's rows hold now: every media block (the types contentMediaUses
-- reads) with a positive numeric mediaId that is still in the library, in the working copy
-- and in the published copy. The blocks map holds nested blocks too, so this reaches an
-- image inside a group as the Go walk does.
WITH docs AS (
  SELECT t.id AS template_id, false AS published, t.block_doc AS doc
  FROM site_templates t
  UNION ALL
  SELECT t.id, true, t.published_block_doc
  FROM site_templates t
  WHERE t.published_block_doc IS NOT NULL
), uses AS (
  -- Compared as numeric inside a CASE (evaluated in order) before the bigint cast: an
  -- out-of-range or fractional id (the Go side truncates, then skips < 1) must not fail
  -- the migration.
  SELECT d.template_id, d.published, b.key AS block_id, b.value ->> 'type' AS block_type,
         CASE WHEN trunc((b.value -> 'attrs' ->> 'mediaId')::numeric) BETWEEN 1 AND 9223372036854775807
              THEN trunc((b.value -> 'attrs' ->> 'mediaId')::numeric)::bigint END AS media_id
  FROM docs d
  CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(d.doc -> 'blocks') = 'object' THEN d.doc -> 'blocks' ELSE '{}'::jsonb END
  ) AS b(key, value)
  WHERE jsonb_typeof(b.value) = 'object'
    AND b.value ->> 'type' IN ('image', 'video', 'audio', 'file', 'cover', 'media_text')
    AND jsonb_typeof(b.value -> 'attrs' -> 'mediaId') = 'number'
)
INSERT INTO "site_template_media" ("template_id", "media_id", "block_id", "block_type", "published")
SELECT u.template_id, u.media_id, u.block_id, u.block_type, u.published
FROM uses u
JOIN media m ON m.id = u.media_id
ON CONFLICT DO NOTHING;
