package db

import (
	"context"
	"crypto/rand"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// Profile (#334): avatars, email change tokens and signing out other sessions,
// against the real database.

func randomTokenHash(t *testing.T) []byte {
	t.Helper()
	b := make([]byte, 32)
	_, err := rand.Read(b)
	require.NoError(t, err)
	return b
}

func uniqueTestEmail(prefix string) string {
	return prefix + strings.ReplaceAll(uuid.NewString(), "-", "")[:12] + "@example.test"
}

func TestSetUserAvatarReturnsThePreviousOne(t *testing.T) {
	ctx := context.Background()
	user := createRandomUser(t)
	require.Equal(t, "", user.AvatarUrl)

	prev, err := testQueries.SetUserAvatar(ctx, SetUserAvatarParams{UserID: user.ID, AvatarUrl: "/uploads/media/_avatars/a.jpg"})
	require.NoError(t, err)
	require.Equal(t, "", prev)

	prev, err = testQueries.SetUserAvatar(ctx, SetUserAvatarParams{UserID: user.ID, AvatarUrl: ""})
	require.NoError(t, err)
	require.Equal(t, "/uploads/media/_avatars/a.jpg", prev)

	got, err := testQueries.GetUser(ctx, user.ID)
	require.NoError(t, err)
	require.Equal(t, "", got.AvatarUrl)

	// Two at once: each sees the other's as the previous one, so no file is orphaned.
	var wg sync.WaitGroup
	results := make([]string, 2)
	for i, url := range []string{"/x/one.jpg", "/x/two.jpg"} {
		wg.Add(1)
		go func(i int, url string) {
			defer wg.Done()
			p, err := testQueries.SetUserAvatar(ctx, SetUserAvatarParams{UserID: user.ID, AvatarUrl: url})
			require.NoError(t, err)
			results[i] = p
		}(i, url)
	}
	wg.Wait()
	got, err = testQueries.GetUser(ctx, user.ID)
	require.NoError(t, err)
	first := "/x/one.jpg"
	if got.AvatarUrl == first {
		first = "/x/two.jpg"
	}
	require.ElementsMatch(t, []string{"", first}, results, "the first writer sees none, the last sees the first's")
}

func TestConfirmEmailChangeTx(t *testing.T) {
	ctx := context.Background()
	user := createRandomUser(t)
	newEmail := uniqueTestEmail("moved")
	hash := randomTokenHash(t)

	// A reset link sent to the old address before the change.
	_, err := testQueries.CreatePasswordResetToken(ctx, CreatePasswordResetTokenParams{UserID: user.ID, TokenHash: randomTokenHash(t), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)

	older := randomTokenHash(t)
	_, err = testStore.RequestEmailChangeTx(ctx, CreateEmailChangeTokenParams{UserID: user.ID, NewEmail: uniqueTestEmail("older"), TokenHash: older, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	_, err = testStore.RequestEmailChangeTx(ctx, CreateEmailChangeTokenParams{UserID: user.ID, NewEmail: newEmail, TokenHash: hash, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)

	_, err = testStore.ConfirmEmailChangeTx(ctx, older)
	require.ErrorIs(t, err, ErrTokenInvalid, "the newer request ended the older link")

	result, err := testStore.ConfirmEmailChangeTx(ctx, hash)
	require.NoError(t, err)
	require.Equal(t, user.Email, result.OldEmail)
	require.Equal(t, newEmail, result.User.Email)

	_, err = testStore.ConfirmEmailChangeTx(ctx, hash)
	require.ErrorIs(t, err, ErrTokenInvalid, "single use")

	n, err := testQueries.CountPasswordResetTokensSince(ctx, CountPasswordResetTokensSinceParams{UserID: user.ID, CreatedAt: time.Now().Add(-time.Hour)})
	require.NoError(t, err)
	require.Equal(t, int64(1), n)
	_, err = testStore.ResetPasswordTx(ctx, ResetPasswordTxParams{TokenHash: hash})
	require.ErrorIs(t, err, ErrTokenInvalid)

	// Taken meanwhile: nothing changes, and the link isn't spent.
	other := createRandomUser(t)
	taken := randomTokenHash(t)
	_, err = testStore.RequestEmailChangeTx(ctx, CreateEmailChangeTokenParams{UserID: user.ID, NewEmail: other.Email, TokenHash: taken, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	_, err = testStore.ConfirmEmailChangeTx(ctx, taken)
	require.ErrorIs(t, err, ErrEmailTaken)
	_, err = testQueries.GetValidEmailChangeTokenByHash(ctx, taken)
	require.NoError(t, err)
}

func TestSignOutOtherSessionsTx(t *testing.T) {
	ctx := context.Background()
	user := createRandomUser(t)
	keep := createRandomSession(t, user)
	createRandomSession(t, user)
	createRandomSession(t, user)
	stranger := createRandomUser(t)
	strangers := createRandomSession(t, stranger)

	active, err := testQueries.ListActiveSessionsByUser(ctx, user.ID)
	require.NoError(t, err)
	require.Len(t, active, 3)

	_, err = testStore.SignOutOtherSessionsTx(ctx, SignOutOtherSessionsTxParams{UserID: user.ID, RefreshTokenHash: strangers.RefreshTokenHash})
	require.ErrorIs(t, err, ErrSessionNotActive, "another user's session")

	result, err := testStore.SignOutOtherSessionsTx(ctx, SignOutOtherSessionsTxParams{UserID: user.ID, RefreshTokenHash: keep.RefreshTokenHash})
	require.NoError(t, err)
	require.Equal(t, keep.ID, result.KeptSessionID)
	require.Equal(t, int64(2), result.Blocked)

	active, err = testQueries.ListActiveSessionsByUser(ctx, user.ID)
	require.NoError(t, err)
	require.Len(t, active, 1)
	require.Equal(t, keep.ID, active[0].ID)

	still, err := testQueries.ListActiveSessionsByUser(ctx, stranger.ID)
	require.NoError(t, err)
	require.Len(t, still, 1, "nobody else is touched")

	require.NoError(t, testQueries.BlockSession(ctx, keep.ID))
	_, err = testStore.SignOutOtherSessionsTx(ctx, SignOutOtherSessionsTxParams{UserID: user.ID, RefreshTokenHash: keep.RefreshTokenHash})
	require.ErrorIs(t, err, ErrSessionNotActive, "a blocked session")
}
