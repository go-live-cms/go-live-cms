package db

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// testTokenHash is a stand-in for the API's SHA-256 token hash.
func testTokenHash() []byte {
	sum := sha256.Sum256([]byte(uuid.NewString()))
	return sum[:]
}

func uniqueEmail() string {
	return "invitee-" + uuid.NewString() + "@example.com"
}

func createTestInvitation(t *testing.T, email, role string, expiresAt time.Time) UserInvitation {
	t.Helper()
	inviter := createTestUser(t)
	inv, err := testStore.CreateUserInvitationTx(context.Background(), CreateUserInvitationParams{
		Email:     email,
		Role:      role,
		TokenHash: testTokenHash(),
		InvitedBy: sql.NullInt64{Int64: inviter.ID, Valid: true},
		ExpiresAt: expiresAt,
	})
	require.NoError(t, err)
	return inv
}

func acceptParams(hash []byte) AcceptInvitationTxParams {
	return AcceptInvitationTxParams{
		TokenHash:      hash,
		Username:       "invited-" + uuid.NewString()[:8],
		FullName:       "Invited Person",
		HashedPassword: "hashed",
	}
}

func TestAcceptInvitationTx(t *testing.T) {
	ctx := context.Background()

	t.Run("creates the user with the invited email and role, once", func(t *testing.T) {
		email := uniqueEmail()
		inv := createTestInvitation(t, email, "editor", time.Now().Add(time.Hour))

		params := acceptParams(inv.TokenHash)
		result, err := testStore.AcceptInvitationTx(ctx, params)
		require.NoError(t, err)
		require.Equal(t, email, result.User.Email)
		require.Equal(t, "editor", result.User.Role)
		require.Equal(t, params.Username, result.User.Username)
		require.True(t, result.Invitation.AcceptedAt.Valid)
		require.Equal(t, result.User.ID, result.Invitation.AcceptedUserID.Int64)

		// Single use: the same link can't create a second account.
		_, err = testStore.AcceptInvitationTx(ctx, acceptParams(inv.TokenHash))
		require.ErrorIs(t, err, ErrTokenInvalid)

		_, err = testQueries.GetValidUserInvitationByTokenHash(ctx, inv.TokenHash)
		require.ErrorIs(t, err, sql.ErrNoRows)
	})

	t.Run("expired", func(t *testing.T) {
		inv := createTestInvitation(t, uniqueEmail(), "contributor", time.Now().Add(-time.Minute))
		_, err := testStore.AcceptInvitationTx(ctx, acceptParams(inv.TokenHash))
		require.ErrorIs(t, err, ErrTokenInvalid)
		_, err = testQueries.GetValidUserInvitationByTokenHash(ctx, inv.TokenHash)
		require.ErrorIs(t, err, sql.ErrNoRows)
	})

	t.Run("revoked", func(t *testing.T) {
		inv := createTestInvitation(t, uniqueEmail(), "contributor", time.Now().Add(time.Hour))
		rows, err := testQueries.RevokeUserInvitation(ctx, inv.ID)
		require.NoError(t, err)
		require.EqualValues(t, 1, rows)

		_, err = testStore.AcceptInvitationTx(ctx, acceptParams(inv.TokenHash))
		require.ErrorIs(t, err, ErrTokenInvalid)

		rows, err = testQueries.RevokeUserInvitation(ctx, inv.ID)
		require.NoError(t, err)
		require.Zero(t, rows, "already revoked")
	})

	t.Run("unknown token", func(t *testing.T) {
		_, err := testStore.AcceptInvitationTx(ctx, acceptParams(testTokenHash()))
		require.ErrorIs(t, err, ErrTokenInvalid)
	})

	t.Run("a taken username leaves the invitation usable", func(t *testing.T) {
		existing := createTestUser(t)
		inv := createTestInvitation(t, uniqueEmail(), "editor", time.Now().Add(time.Hour))

		params := acceptParams(inv.TokenHash)
		params.Username = existing.Username
		_, err := testStore.AcceptInvitationTx(ctx, params)
		require.Error(t, err)
		require.NotErrorIs(t, err, ErrTokenInvalid)

		_, err = testStore.AcceptInvitationTx(ctx, acceptParams(inv.TokenHash))
		require.NoError(t, err, "the failed attempt must not have used up the link")
	})

	t.Run("concurrent accepts: exactly one wins", func(t *testing.T) {
		inv := createTestInvitation(t, uniqueEmail(), "contributor", time.Now().Add(time.Hour))

		const n = 5
		errs := make([]error, n)
		var wg sync.WaitGroup
		for i := range n {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, errs[i] = testStore.AcceptInvitationTx(ctx, acceptParams(inv.TokenHash))
			}()
		}
		wg.Wait()

		ok := 0
		for _, err := range errs {
			if err == nil {
				ok++
			} else {
				require.ErrorIs(t, err, ErrTokenInvalid)
			}
		}
		require.Equal(t, 1, ok)
	})
}

func TestCreateUserInvitationTxRevokesPreviousInvite(t *testing.T) {
	ctx := context.Background()
	email := uniqueEmail()
	first := createTestInvitation(t, email, "contributor", time.Now().Add(time.Hour))
	second := createTestInvitation(t, email, "editor", time.Now().Add(time.Hour))

	_, err := testQueries.GetValidUserInvitationByTokenHash(ctx, first.TokenHash)
	require.ErrorIs(t, err, sql.ErrNoRows, "only the newest link works")
	got, err := testQueries.GetValidUserInvitationByTokenHash(ctx, second.TokenHash)
	require.NoError(t, err)
	require.Equal(t, "editor", got.Role)

	open, err := testQueries.ListOpenUserInvitations(ctx)
	require.NoError(t, err)
	count := 0
	for _, inv := range open {
		if inv.Email == email {
			count++
		}
	}
	require.Equal(t, 1, count)

	// The partial unique index backs this up for a bare insert.
	_, err = testQueries.CreateUserInvitation(ctx, CreateUserInvitationParams{
		Email: email, Role: "editor", TokenHash: testTokenHash(), ExpiresAt: time.Now().Add(time.Hour),
	})
	require.Error(t, err)
}

func TestRenewUserInvitation(t *testing.T) {
	ctx := context.Background()
	inv := createTestInvitation(t, uniqueEmail(), "contributor", time.Now().Add(-time.Hour)) // expired

	newHash := testTokenHash()
	renewed, err := testQueries.RenewUserInvitation(ctx, RenewUserInvitationParams{
		ID: inv.ID, TokenHash: newHash, ExpiresAt: time.Now().Add(time.Hour),
	})
	require.NoError(t, err)
	require.Equal(t, newHash, renewed.TokenHash)

	_, err = testQueries.GetValidUserInvitationByTokenHash(ctx, inv.TokenHash)
	require.ErrorIs(t, err, sql.ErrNoRows, "the old link stops working")
	_, err = testQueries.GetValidUserInvitationByTokenHash(ctx, newHash)
	require.NoError(t, err)

	// An accepted invitation can't be renewed.
	_, err = testStore.AcceptInvitationTx(ctx, acceptParams(newHash))
	require.NoError(t, err)
	_, err = testQueries.RenewUserInvitation(ctx, RenewUserInvitationParams{
		ID: inv.ID, TokenHash: testTokenHash(), ExpiresAt: time.Now().Add(time.Hour),
	})
	require.ErrorIs(t, err, sql.ErrNoRows)
}

func createTestResetToken(t *testing.T, user User, expiresAt time.Time) PasswordResetToken {
	t.Helper()
	token, err := testQueries.CreatePasswordResetToken(context.Background(), CreatePasswordResetTokenParams{
		UserID: user.ID, TokenHash: testTokenHash(), ExpiresAt: expiresAt,
	})
	require.NoError(t, err)
	return token
}

func createTestSession(t *testing.T, user User) Session {
	t.Helper()
	session, err := testQueries.CreateSession(context.Background(), CreateSessionParams{
		ID:               uuid.New(),
		UserID:           user.ID,
		Username:         user.Username,
		RefreshTokenHash: []byte(uuid.NewString()),
		UserAgent:        "test",
		ClientIp:         "127.0.0.1",
		ExpiresAt:        time.Now().Add(time.Hour),
	})
	require.NoError(t, err)
	return session
}

func TestResetPasswordTx(t *testing.T) {
	ctx := context.Background()

	t.Run("sets the password, revokes sessions, single use", func(t *testing.T) {
		user := createTestUser(t)
		other := createTestUser(t)
		sessions := []Session{createTestSession(t, user), createTestSession(t, user)}
		otherSession := createTestSession(t, other)
		token := createTestResetToken(t, user, time.Now().Add(time.Hour))
		sibling := createTestResetToken(t, user, time.Now().Add(time.Hour))

		before := time.Now()
		updated, err := testStore.ResetPasswordTx(ctx, ResetPasswordTxParams{TokenHash: token.TokenHash, HashedPassword: "new-hash"})
		require.NoError(t, err)
		require.Equal(t, user.ID, updated.ID)
		require.Equal(t, "new-hash", updated.HashedPassword)
		// authMiddleware rejects access tokens issued before this.
		require.False(t, updated.PasswordChangedAt.Before(before.Truncate(time.Microsecond)))

		for _, s := range sessions {
			got, err := testQueries.GetSession(ctx, s.ID)
			require.NoError(t, err)
			require.True(t, got.IsBlocked, "every session of the user is revoked")
		}
		got, err := testQueries.GetSession(ctx, otherSession.ID)
		require.NoError(t, err)
		require.False(t, got.IsBlocked)

		_, err = testStore.ResetPasswordTx(ctx, ResetPasswordTxParams{TokenHash: token.TokenHash, HashedPassword: "again"})
		require.ErrorIs(t, err, ErrTokenInvalid, "the link works once")
		_, err = testStore.ResetPasswordTx(ctx, ResetPasswordTxParams{TokenHash: sibling.TokenHash, HashedPassword: "again"})
		require.ErrorIs(t, err, ErrTokenInvalid, "other outstanding links die with it")

		stored, err := testQueries.GetUser(ctx, user.ID)
		require.NoError(t, err)
		require.Equal(t, "new-hash", stored.HashedPassword)
	})

	t.Run("expired", func(t *testing.T) {
		user := createTestUser(t)
		token := createTestResetToken(t, user, time.Now().Add(-time.Second))
		_, err := testStore.ResetPasswordTx(ctx, ResetPasswordTxParams{TokenHash: token.TokenHash, HashedPassword: "x"})
		require.ErrorIs(t, err, ErrTokenInvalid)

		stored, err := testQueries.GetUser(ctx, user.ID)
		require.NoError(t, err)
		require.Equal(t, user.HashedPassword, stored.HashedPassword)
	})

	t.Run("unknown", func(t *testing.T) {
		_, err := testStore.ResetPasswordTx(ctx, ResetPasswordTxParams{TokenHash: testTokenHash(), HashedPassword: "x"})
		require.ErrorIs(t, err, ErrTokenInvalid)
	})

	t.Run("a password change invalidates outstanding links", func(t *testing.T) {
		user := createTestUser(t)
		token := createTestResetToken(t, user, time.Now().Add(time.Hour))

		_, err := testStore.UpdateUserTx(ctx, UpdateUserTxParams{
			UpdateUserParams: UpdateUserParams{
				ID: user.ID, Username: user.Username, FullName: user.FullName, Email: user.Email,
				HashedPassword: "changed", Role: user.Role, PasswordChangedAt: user.PasswordChangedAt,
			},
			PasswordChanged: true,
		})
		require.NoError(t, err)

		_, err = testStore.ResetPasswordTx(ctx, ResetPasswordTxParams{TokenHash: token.TokenHash, HashedPassword: "x"})
		require.ErrorIs(t, err, ErrTokenInvalid)
	})

	t.Run("deleting the user deletes their tokens", func(t *testing.T) {
		user := createTestUser(t)
		token := createTestResetToken(t, user, time.Now().Add(time.Hour))
		require.NoError(t, testStore.DeleteUserTx(ctx, user.ID))
		_, err := testQueries.GetValidPasswordResetTokenByHash(ctx, token.TokenHash)
		require.ErrorIs(t, err, sql.ErrNoRows)
	})
}

func TestCountPasswordResetTokensSince(t *testing.T) {
	ctx := context.Background()
	user := createTestUser(t)
	since := time.Now().Add(-time.Minute)

	n, err := testQueries.CountPasswordResetTokensSince(ctx, CountPasswordResetTokensSinceParams{UserID: user.ID, CreatedAt: since})
	require.NoError(t, err)
	require.Zero(t, n)

	createTestResetToken(t, user, time.Now().Add(time.Hour))
	n, err = testQueries.CountPasswordResetTokensSince(ctx, CountPasswordResetTokensSinceParams{UserID: user.ID, CreatedAt: since})
	require.NoError(t, err)
	require.EqualValues(t, 1, n)
}
