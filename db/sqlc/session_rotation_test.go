package db

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// createSessionWithHash creates an active session for user whose refresh
// token hash is sha256(refreshToken), as the API stores it.
func createSessionWithHash(t *testing.T, user User, refreshToken string) Session {
	t.Helper()
	hash := sha256.Sum256([]byte(refreshToken))
	session, err := testQueries.CreateSession(context.Background(), CreateSessionParams{
		ID:               uuid.New(),
		UserID:           user.ID,
		Username:         user.Username,
		RefreshTokenHash: hash[:],
		UserAgent:        "test-agent",
		ClientIp:         "192.0.2.10",
		ExpiresAt:        time.Now().Add(time.Hour),
	})
	require.NoError(t, err)
	return session
}

// rotateSession runs the same statements, in the same order, as the refresh
// handler's rotation transaction (api.renewAccessToken), and returns the new
// session and how many rows RotateToNewSession touched.
func rotateSession(t *testing.T, old Session, newRefreshToken string) (Session, int64) {
	t.Helper()
	ctx := context.Background()
	hash := sha256.Sum256([]byte(newRefreshToken))

	var created Session
	var rows int64
	err := testStore.ExecTx(ctx, func(q *Queries) error {
		if err := q.LockUserForShare(ctx, old.UserID); err != nil {
			return err
		}
		if _, err := q.GetSessionForUpdate(ctx, old.ID); err != nil {
			return err
		}
		var err error
		created, err = q.CreateSession(ctx, CreateSessionParams{
			ID:               uuid.New(),
			UserID:           old.UserID,
			Username:         old.Username,
			RefreshTokenHash: hash[:],
			UserAgent:        old.UserAgent,
			ClientIp:         old.ClientIp,
			ExpiresAt:        time.Now().Add(time.Hour),
		})
		if err != nil {
			return err
		}
		rows, err = q.RotateToNewSession(ctx, RotateToNewSessionParams{
			ID:         old.ID,
			ReplacedBy: uuid.NullUUID{UUID: created.ID, Valid: true},
		})
		return err
	})
	require.NoError(t, err)
	return created, rows
}

// TestRefreshRotationAgainstPostgres checks the session queries refresh-token
// rotation and reuse detection rely on, against the real schema.
func TestRefreshRotationAgainstPostgres(t *testing.T) {
	ctx := context.Background()
	user := createTestUser(t)
	oldToken, newToken := "refresh-1-"+uuid.NewString(), "refresh-2-"+uuid.NewString()
	old := createSessionWithHash(t, user, oldToken)

	next, rows := rotateSession(t, old, newToken)
	require.Equal(t, int64(1), rows)

	oldHash := sha256.Sum256([]byte(oldToken))
	newHash := sha256.Sum256([]byte(newToken))

	// The spent token no longer finds an active session...
	_, err := testQueries.GetSessionByRefreshTokenHash(ctx, oldHash[:])
	require.ErrorIs(t, err, sql.ErrNoRows)

	// ...but is still found as a rotated one, which is how the handler tells
	// reuse (409, block everything) from a plain revoked session (401).
	spent, err := testQueries.GetAnySessionByRefreshTokenHash(ctx, oldHash[:])
	require.NoError(t, err)
	require.True(t, spent.IsBlocked)
	require.True(t, spent.ReplacedBy.Valid)
	require.Equal(t, next.ID, spent.ReplacedBy.UUID)
	require.True(t, spent.RotatedAt.Valid)

	active, err := testQueries.GetSessionByRefreshTokenHash(ctx, newHash[:])
	require.NoError(t, err)
	require.Equal(t, next.ID, active.ID)
	require.False(t, active.ReplacedBy.Valid)

	// A second rotation of the spent session (a concurrent refresh that lost
	// the row lock) matches nothing: the handler maps 0 rows to 401.
	_, rows = rotateSession(t, old, "refresh-3-"+uuid.NewString())
	require.Zero(t, rows)
}

// A session revoked by logout or a password change is blocked but never
// rotated, so it must not look like reuse.
func TestRevokedSessionIsNotRotated(t *testing.T) {
	ctx := context.Background()
	user := createTestUser(t)
	refreshToken := "revoked-refresh-" + uuid.NewString()
	session := createSessionWithHash(t, user, refreshToken)

	require.NoError(t, testQueries.BlockSession(ctx, session.ID))

	hash := sha256.Sum256([]byte(refreshToken))
	got, err := testQueries.GetAnySessionByRefreshTokenHash(ctx, hash[:])
	require.NoError(t, err)
	require.True(t, got.IsBlocked)
	require.False(t, got.ReplacedBy.Valid)
	require.False(t, got.RotatedAt.Valid)

	// Blocked sessions can't be rotated either.
	rows, err := testQueries.RotateToNewSession(ctx, RotateToNewSessionParams{
		ID:         session.ID,
		ReplacedBy: uuid.NullUUID{UUID: uuid.New(), Valid: true},
	})
	require.NoError(t, err)
	require.Zero(t, rows)
}

// BlockAllSessionsForUser (reuse response, password change) must hit every
// active session of that user and nobody else's.
func TestBlockAllSessionsForUserIsScoped(t *testing.T) {
	ctx := context.Background()
	victim := createTestUser(t)
	bystander := createTestUser(t)

	v1 := createSessionWithHash(t, victim, "victim-1-"+uuid.NewString())
	v2 := createSessionWithHash(t, victim, "victim-2-"+uuid.NewString())
	b1 := createSessionWithHash(t, bystander, "bystander-"+uuid.NewString())

	require.NoError(t, testQueries.BlockAllSessionsForUser(ctx, victim.ID))

	for _, id := range []uuid.UUID{v1.ID, v2.ID} {
		s, err := testQueries.GetSession(ctx, id)
		require.NoError(t, err)
		require.True(t, s.IsBlocked)
	}
	s, err := testQueries.GetSession(ctx, b1.ID)
	require.NoError(t, err)
	require.False(t, s.IsBlocked)
}
