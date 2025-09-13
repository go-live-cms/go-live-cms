-- name: CreateSession :one
INSERT INTO sessions (
    id,
    user_id,
    username,
    refresh_token,
    refresh_token_hash,
    refresh_kid,
    jti,
    user_agent,
    client_ip,
    is_blocked,
    expires_at
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
) RETURNING *;

-- name: UpdateSession :one
UPDATE sessions 
SET 
    username = COALESCE($2, username)
WHERE id = $1
RETURNING *;

-- name: GetSession :one
SELECT * FROM sessions
WHERE id = $1 LIMIT 1;

-- name: ListSessionsByUsername :many
SELECT * FROM sessions
WHERE username = $1;

-- name: ListSessionsByUser :many
SELECT * FROM sessions
WHERE user_id = $1;

-- name: UpdateSessionsUsername :many
UPDATE sessions
SET username = $2
WHERE username = $1
RETURNING *;

-- name: BlockSession :exec
UPDATE sessions
SET is_blocked = true
WHERE id = $1;

-- name: GetSessionByRefreshTokenHash :one
SELECT * FROM sessions
WHERE refresh_token_hash = $1 AND is_blocked = false LIMIT 1;

-- name: GetSessionForUpdate :one
SELECT * FROM sessions WHERE id = $1 FOR UPDATE;

-- name: GetAnySessionByRefreshTokenHash :one
SELECT * FROM sessions WHERE refresh_token_hash = $1 LIMIT 1;

-- name: RotateToNewSession :execrows
UPDATE sessions
SET 
    rotated_at = NOW(),
    replaced_by = $2,
    is_blocked = true
WHERE id = $1 AND is_blocked = false;

-- name: BlockAllSessionsForUser :exec
UPDATE sessions
SET is_blocked = true
WHERE user_id = $1 AND is_blocked = false;

-- name: CountTotalSessions :one
SELECT COUNT(*) AS total FROM sessions;