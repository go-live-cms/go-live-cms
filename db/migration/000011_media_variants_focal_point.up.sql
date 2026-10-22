-- Image variants and focal point (issue #255).
--
-- variants maps a variant name (thumb, medium, large) to the resized copy the
-- API generated for an image: {"thumb": {"path": ..., "width": ..., "height":
-- ..., "mime_type": ..., "file_size": ...}}. It is server-owned and empty for
-- non-images and for media without variants yet (the backfill fills those).
--
-- focal_x/focal_y is the optional point of interest (0..1 from the top-left)
-- that the public site uses for object-position when it crops an image. Both
-- are set or both are NULL.
ALTER TABLE "media"
  ADD COLUMN "variants" jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "focal_x" double precision,
  ADD COLUMN "focal_y" double precision,
  ADD CONSTRAINT "media_focal_point_check" CHECK (
    (focal_x IS NULL AND focal_y IS NULL)
    -- IS NOT NULL is spelled out: with one side NULL the range test is NULL,
    -- and a CHECK that evaluates to NULL passes.
    OR (focal_x IS NOT NULL AND focal_y IS NOT NULL
        AND focal_x BETWEEN 0 AND 1 AND focal_y BETWEEN 0 AND 1)
  );
