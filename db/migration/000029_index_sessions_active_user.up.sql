-- #160: BlockAllSessionsForUser (logout-all, password change/reset, refresh reuse)
-- filters user_id = $1 AND is_blocked = false. A partial index holds only the live
-- sessions, so it stays small however many rotated/blocked rows pile up, and the
-- plain (user_id) and refresh_token_hash indexes from 000002 are kept.
CREATE INDEX CONCURRENTLY idx_sessions_user_id_active ON sessions (user_id) WHERE is_blocked = false;
