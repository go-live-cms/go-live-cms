-- Remove plaintext refresh_token column for security
-- The refresh_token_hash column provides all needed functionality
ALTER TABLE sessions DROP COLUMN refresh_token;
