-- Add hashed refresh token + rotation fields
ALTER TABLE sessions
  ADD COLUMN refresh_token_hash bytea,
  ADD COLUMN refresh_kid text,
  ADD COLUMN jti uuid,
  ADD COLUMN rotated_at timestamptz,
  ADD COLUMN replaced_by uuid;

-- Indexes
CREATE INDEX ON sessions (user_id);
CREATE UNIQUE INDEX ON sessions (id);
CREATE INDEX ON sessions (refresh_token_hash);
