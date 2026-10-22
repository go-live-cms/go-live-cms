package db

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// ErrTokenInvalid is returned when an invitation or password reset token
// matches nothing usable: unknown, expired, revoked or already used. Callers
// must not tell these cases apart in responses.
var ErrTokenInvalid = errors.New("token is invalid, expired or already used")

// CreateUserInvitationTx revokes any open invitation for the same email and
// creates a new one, so an email has at most one working invite link.
func (store *SQLStore) CreateUserInvitationTx(ctx context.Context, arg CreateUserInvitationParams) (UserInvitation, error) {
	var invitation UserInvitation

	err := store.execTx(ctx, func(q *Queries) error {
		if err := q.RevokeOpenUserInvitationsByEmail(ctx, arg.Email); err != nil {
			return err
		}
		var err error
		invitation, err = q.CreateUserInvitation(ctx, arg)
		return err
	})

	return invitation, err
}

type AcceptInvitationTxParams struct {
	TokenHash      []byte
	Username       string
	FullName       string
	HashedPassword string
}

type AcceptInvitationTxResult struct {
	User       User           `json:"user"`
	Invitation UserInvitation `json:"invitation"`
}

// AcceptInvitationTx claims a valid invitation and creates its user with the
// invited email and role. The claim and the user commit together: if creating
// the user fails (say the username is taken) the invitation stays usable.
// Returns ErrTokenInvalid when the token matches no valid invitation.
func (store *SQLStore) AcceptInvitationTx(ctx context.Context, arg AcceptInvitationTxParams) (AcceptInvitationTxResult, error) {
	var result AcceptInvitationTxResult

	err := store.execTx(ctx, func(q *Queries) error {
		var err error
		result.Invitation, err = q.ClaimUserInvitation(ctx, arg.TokenHash)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrTokenInvalid
			}
			return err
		}

		result.User, err = q.CreateUser(ctx, CreateUserParams{
			Username:       arg.Username,
			FullName:       arg.FullName,
			Email:          result.Invitation.Email,
			HashedPassword: arg.HashedPassword,
			Role:           result.Invitation.Role,
		})
		if err != nil {
			return err
		}

		result.Invitation.AcceptedUserID = sql.NullInt64{Int64: result.User.ID, Valid: true}
		return q.SetUserInvitationAcceptedUser(ctx, SetUserInvitationAcceptedUserParams{
			ID:             result.Invitation.ID,
			AcceptedUserID: result.Invitation.AcceptedUserID,
		})
	})

	return result, err
}

type ResetPasswordTxParams struct {
	TokenHash      []byte
	HashedPassword string
}

// ResetPasswordTx redeems a password reset token: it sets the new password and
// revokes everything the old one granted, exactly like a password change in
// UpdateUserTx. It locks the user row, stamps password_changed_at after the
// lock (authMiddleware then rejects older access tokens), blocks every
// session, and uses up every other outstanding reset token for the user.
// Returns ErrTokenInvalid when the token matches no valid reset token.
func (store *SQLStore) ResetPasswordTx(ctx context.Context, arg ResetPasswordTxParams) (User, error) {
	var user User

	err := store.execTx(ctx, func(q *Queries) error {
		// Find the user first and lock their row before touching token rows,
		// the same order UpdateUserTx uses (user, then tokens), so a reset
		// racing a self password change can't deadlock.
		token, err := q.GetValidPasswordResetTokenByHash(ctx, arg.TokenHash)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrTokenInvalid
			}
			return err
		}
		if err := q.LockUserForUpdate(ctx, token.UserID); err != nil {
			return err
		}

		// The claim re-checks the token under its row lock: a concurrent
		// reset with the same token that committed first leaves no match.
		if _, err := q.ClaimPasswordResetToken(ctx, arg.TokenHash); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrTokenInvalid
			}
			return err
		}

		user, err = q.SetUserPassword(ctx, SetUserPasswordParams{
			ID:                token.UserID,
			HashedPassword:    arg.HashedPassword,
			PasswordChangedAt: time.Now(),
		})
		if err != nil {
			return err
		}

		if err := q.BlockAllSessionsForUser(ctx, token.UserID); err != nil {
			return err
		}
		return q.InvalidatePasswordResetTokensForUser(ctx, token.UserID)
	})

	return user, err
}
