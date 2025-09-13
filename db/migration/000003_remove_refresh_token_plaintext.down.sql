-- Add back plaintext refresh_token column (rollback)
-- This is for migration rollback only - avoid using plaintext storage in production
ALTER TABLE sessions ADD COLUMN refresh_token text NOT NULL DEFAULT '';
