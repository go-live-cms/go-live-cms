-- Drop indexes
DROP INDEX IF EXISTS sessions_user_id_idx;
DROP INDEX IF EXISTS sessions_id_idx;
DROP INDEX IF EXISTS sessions_refresh_token_hash_idx;

-- Drop columns
ALTER TABLE sessions
  DROP COLUMN IF EXISTS refresh_token_hash,
  DROP COLUMN IF EXISTS refresh_kid,
  DROP COLUMN IF EXISTS jti,
  DROP COLUMN IF EXISTS rotated_at,
  DROP COLUMN IF EXISTS replaced_by;
