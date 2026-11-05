package db

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

// SignupRole is the role every account created by open signup gets (#191). It is
// fixed: the only other non-admin role, editor, publishes, and open signup would
// hand that to anyone on the internet.
const SignupRole = "contributor"

// ErrUsernameTaken is returned by ConfirmSignupTx when another account took the
// username after the signup was requested.
var ErrUsernameTaken = errors.New("username is already in use")

// RequestSignupTx stores a pending signup (#191), ending every earlier pending link
// for the same email, so only the latest request can be confirmed, and deleting
// rows that expired.
func (store *SQLStore) RequestSignupTx(ctx context.Context, arg CreateSignupRequestParams) (SignupRequest, error) {
	var request SignupRequest

	err := store.execTx(ctx, func(q *Queries) error {
		if _, err := q.DeleteStaleSignupRequests(ctx); err != nil {
			return err
		}
		if err := q.DeleteSignupRequestsByEmail(ctx, arg.Email); err != nil {
			return err
		}
		var err error
		request, err = q.CreateSignupRequest(ctx, arg)
		return err
	})

	return request, err
}

// ConfirmSignupTx redeems a signup link (#191): it claims the pending signup and
// creates its account as a contributor (the claim deletes the row, so its password
// hash doesn't linger), then deletes the address's other pending signups.
//
// Returns ErrTokenInvalid for a token that is unknown, expired or used,
// ErrEmailTaken when an account with the email exists now (an invitation accepted
// meanwhile, say), and ErrUsernameTaken when the username was taken since. On an
// error nothing is written.
func (store *SQLStore) ConfirmSignupTx(ctx context.Context, tokenHash []byte) (User, error) {
	var user User

	err := store.execTx(ctx, func(q *Queries) error {
		request, err := q.ClaimSignupRequest(ctx, tokenHash)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrTokenInvalid
			}
			return err
		}

		// Checked first so the answer doesn't depend on which unique index the
		// insert would trip; the insert's own violation covers a race.
		if _, err := q.GetUserByEmailFold(ctx, request.Email); err == nil {
			return ErrEmailTaken
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if _, err := q.GetUserByUsername(ctx, request.Username); err == nil {
			return ErrUsernameTaken
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}

		user, err = q.CreateUser(ctx, CreateUserParams{
			Username:       request.Username,
			FullName:       request.FullName,
			Email:          request.Email,
			HashedPassword: request.HashedPassword,
			Role:           SignupRole,
		})
		if err != nil {
			if IsUniqueViolation(err) {
				if strings.Contains(err.Error(), "email") {
					return ErrEmailTaken
				}
				return ErrUsernameTaken
			}
			return err
		}

		return q.DeleteSignupRequestsByEmail(ctx, request.Email)
	})

	return user, err
}

// IsUniqueViolation reports a unique constraint violation, by message, so no
// driver type is needed (the api package's isUniqueViolation uses it).
func IsUniqueViolation(err error) bool {
	msg := err.Error()
	return strings.Contains(msg, "duplicate key value") || strings.Contains(msg, "unique constraint")
}
