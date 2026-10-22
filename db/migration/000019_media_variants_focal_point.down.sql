ALTER TABLE "media"
  DROP CONSTRAINT IF EXISTS "media_focal_point_check",
  DROP COLUMN IF EXISTS "focal_y",
  DROP COLUMN IF EXISTS "focal_x",
  DROP COLUMN IF EXISTS "variants";
