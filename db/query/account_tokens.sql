-- Invitations and password reset tokens (#148). Only token hashes are stored.
-- "Open" invitations are neither accepted nor revoked (they may have expired);
-- "valid" ones are open and unexpired.

-- name: CreateUserInvitation :one
INSERT INTO user_invitations (
    email,
    role,
    token_hash,
    invited_by,
    expires_at
) VALUES (
    $1, $2, $3, $4, $5
) RETURNING *;

-- name: RevokeOpenUserInvitationsByEmail :exec
UPDATE user_invitations
SET revoked_at = now()
WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL;

-- name: ListOpenUserInvitations :many
-- What the admin Users page shows. Invitations that expired over 30 days ago
-- are dropped (nobody is waiting on them any more), and the list is capped.
SELECT * FROM user_invitations
WHERE accepted_at IS NULL AND revoked_at IS NULL
  AND expires_at > now() - interval '30 days'
ORDER BY created_at DESC, id DESC
LIMIT 200;

-- name: RevokeUserInvitation :execrows
UPDATE user_invitations
SET revoked_at = now()
WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL;

-- name: RenewUserInvitation :one
-- Resend: a new token (the old link stops working) and a new expiry.
UPDATE user_invitations
SET token_hash = $2, expires_at = $3
WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
RETURNING *;

-- name: GetValidUserInvitationByTokenHash :one
SELECT * FROM user_invitations
WHERE token_hash = $1
  AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
LIMIT 1;

-- name: ClaimUserInvitation :one
-- Marks a valid invitation accepted in one statement, so two concurrent
-- accepts can't both succeed: the loser re-checks accepted_at after the
-- winner commits and matches no row.
UPDATE user_invitations
SET accepted_at = now()
WHERE token_hash = $1
  AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
RETURNING *;

-- name: SetUserInvitationAcceptedUser :exec
UPDATE user_invitations
SET accepted_user_id = $2
WHERE id = $1;

-- name: CreatePasswordResetToken :one
INSERT INTO password_reset_tokens (
    user_id,
    token_hash,
    expires_at
) VALUES (
    $1, $2, $3
) RETURNING *;

-- name: CountPasswordResetTokensSince :one
SELECT COUNT(*) FROM password_reset_tokens
WHERE user_id = $1 AND created_at > $2;

-- name: GetValidPasswordResetTokenByHash :one
SELECT * FROM password_reset_tokens
WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
LIMIT 1;

-- name: ClaimPasswordResetToken :one
-- Single-use: like ClaimUserInvitation, only one claim can match.
UPDATE password_reset_tokens
SET used_at = now()
WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
RETURNING *;

-- name: InvalidatePasswordResetTokensForUser :exec
UPDATE password_reset_tokens
SET used_at = now()
WHERE user_id = $1 AND used_at IS NULL;

-- Email change (#334): the confirmation link goes to the new address; the change
-- happens only when it is redeemed (ConfirmEmailChangeTx).

-- name: CreateEmailChangeToken :one
INSERT INTO email_change_tokens (
    user_id,
    new_email,
    token_hash,
    expires_at
) VALUES (
    $1, $2, $3, $4
) RETURNING *;

-- name: CountEmailChangeTokensSince :one
SELECT COUNT(*) FROM email_change_tokens
WHERE user_id = $1 AND created_at > $2;

-- name: GetValidEmailChangeTokenByHash :one
SELECT * FROM email_change_tokens
WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
LIMIT 1;

-- name: ClaimEmailChangeToken :one
-- Single-use: like ClaimPasswordResetToken, only one claim can match.
UPDATE email_change_tokens
SET used_at = now()
WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
RETURNING *;

-- name: InvalidateEmailChangeTokensForUser :exec
-- A newer request, a confirmed change or a password change/reset ends every
-- other pending link.
UPDATE email_change_tokens
SET used_at = now()
WHERE user_id = $1 AND used_at IS NULL;

-- Open signup (#191): the account is created only when the emailed link is
-- redeemed (ConfirmSignupTx).

-- name: CreateSignupRequest :one
INSERT INTO signup_requests (
    email,
    username,
    full_name,
    hashed_password,
    token_hash,
    expires_at
) VALUES (
    $1, $2, $3, $4, $5, $6
) RETURNING *;

-- name: DeleteSignupRequestsByEmail :exec
-- A newer signup for the address, or its account being created, ends every
-- other pending link for it.
DELETE FROM signup_requests WHERE email = $1;

-- name: DeleteStaleSignupRequests :execrows
-- Expired rows hold unconfirmed details nobody can use any more.
DELETE FROM signup_requests WHERE expires_at <= now();

-- name: ClaimSignupRequest :one
-- Single use: the claim deletes the row, so only one claim can match (a second
-- waits on the row lock and then finds nothing). Rolled back with the transaction
-- if the account can't be created.
DELETE FROM signup_requests
WHERE token_hash = $1 AND expires_at > now()
RETURNING *;
