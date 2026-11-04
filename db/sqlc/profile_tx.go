package db

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/google/uuid"
)

// ErrEmailTaken is returned by ConfirmEmailChangeTx when another account took
// the new address after the change was requested.
var ErrEmailTaken = errors.New("email address is already in use")

// ErrSessionNotActive is returned by SignOutOtherSessionsTx when the caller's own
// session is unknown, blocked, expired or someone else's.
var ErrSessionNotActive = errors.New("session is not active")

type ConfirmEmailChangeTxResult struct {
	User     User   `json:"user"`
	OldEmail string `json:"old_email"`
}

// ConfirmEmailChangeTx redeems an email change token (#334): it sets the user's
// email to the token's new address, uses up the token and every other pending
// email change link, and uses up the user's password reset links too (they went to
// the old address, which no longer recovers the account).
//
// Lock order matches UpdateUserTx and ResetPasswordTx (user row, then token rows), so
// it can't deadlock with a password change that burns these tokens. Returns
// ErrTokenInvalid for a token that is unknown, expired or used, and ErrEmailTaken
// when another account has the address now; either way nothing is written and the
// token stays as it was.
func (store *SQLStore) ConfirmEmailChangeTx(ctx context.Context, tokenHash []byte) (ConfirmEmailChangeTxResult, error) {
	var result ConfirmEmailChangeTxResult

	err := store.execTx(ctx, func(q *Queries) error {
		token, err := q.GetValidEmailChangeTokenByHash(ctx, tokenHash)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrTokenInvalid
			}
			return err
		}
		if err := q.LockUserForUpdate(ctx, token.UserID); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrTokenInvalid
			}
			return err
		}
		// Re-checked under the token's row lock: a concurrent confirm with the same
		// token that committed first leaves no match.
		if _, err := q.ClaimEmailChangeToken(ctx, tokenHash); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrTokenInvalid
			}
			return err
		}

		user, err := q.GetUser(ctx, token.UserID)
		if err != nil {
			return err
		}
		if other, err := q.GetUserByEmail(ctx, token.NewEmail); err == nil && other.ID != user.ID {
			return ErrEmailTaken
		} else if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}

		result.OldEmail = user.Email
		result.User, err = q.SetUserEmail(ctx, SetUserEmailParams{ID: user.ID, Email: token.NewEmail})
		if err != nil {
			return err
		}
		if err := q.InvalidateEmailChangeTokensForUser(ctx, user.ID); err != nil {
			return err
		}
		return q.InvalidatePasswordResetTokensForUser(ctx, user.ID)
	})

	return result, err
}

// RequestEmailChangeTx stores a new email change token for a user, ending every
// earlier pending link of theirs, so only the latest request can be confirmed.
func (store *SQLStore) RequestEmailChangeTx(ctx context.Context, arg CreateEmailChangeTokenParams) (EmailChangeToken, error) {
	var token EmailChangeToken

	err := store.execTx(ctx, func(q *Queries) error {
		if err := q.InvalidateEmailChangeTokensForUser(ctx, arg.UserID); err != nil {
			return err
		}
		var err error
		token, err = q.CreateEmailChangeToken(ctx, arg)
		return err
	})

	return token, err
}

type SignOutOtherSessionsTxParams struct {
	UserID int64
	// The refresh token hash of the session to keep (the caller's own).
	RefreshTokenHash []byte
}

type SignOutOtherSessionsTxResult struct {
	KeptSessionID uuid.UUID `json:"kept_session_id"`
	Blocked       int64     `json:"blocked"`
}

// SignOutOtherSessionsTx blocks every session of the user except the one the
// refresh token hash names (#334). Like a password change it holds the user row
// FOR UPDATE, which serializes it against refresh-token rotation (LockUserForShare):
// a rotation that committed first has its new session blocked here, and one that
// waits finds its old session blocked and refreshes nothing. Returns
// ErrSessionNotActive when the kept session isn't an active session of this user.
func (store *SQLStore) SignOutOtherSessionsTx(ctx context.Context, arg SignOutOtherSessionsTxParams) (SignOutOtherSessionsTxResult, error) {
	var result SignOutOtherSessionsTxResult

	err := store.execTx(ctx, func(q *Queries) error {
		if err := q.LockUserForUpdate(ctx, arg.UserID); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrSessionNotActive
			}
			return err
		}
		session, err := q.GetSessionByRefreshTokenHash(ctx, arg.RefreshTokenHash)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrSessionNotActive
			}
			return err
		}
		if session.UserID != arg.UserID || !session.ExpiresAt.After(time.Now()) {
			return ErrSessionNotActive
		}
		blocked, err := q.BlockOtherSessionsForUser(ctx, BlockOtherSessionsForUserParams{
			UserID: arg.UserID,
			KeepID: session.ID,
		})
		if err != nil {
			return err
		}
		result = SignOutOtherSessionsTxResult{KeptSessionID: session.ID, Blocked: blocked}
		return nil
	})

	return result, err
}
