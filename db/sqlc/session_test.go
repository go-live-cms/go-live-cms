package db

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/brianvoe/gofakeit/v6"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func createRandomUser(t *testing.T) User {
	gofakeit.Seed(0)

	arg := CreateUserParams{
		Username:       gofakeit.Username(),
		FullName:       gofakeit.Name(),
		Email:          gofakeit.Email(),
		HashedPassword: gofakeit.Password(true, true, true, true, false, 12),
	}

	user, err := testQueries.CreateUser(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, user)

	return user
}

func createRandomSession(t *testing.T, user User) Session {
	gofakeit.Seed(0)

	arg := CreateSessionParams{
		ID:               uuid.New(),
		UserID:           user.ID,
		Username:         user.Username,
		RefreshTokenHash: []byte(gofakeit.UUID()),
		RefreshKid:       sql.NullString{},
		Jti:              uuid.NullUUID{},
		UserAgent:        gofakeit.UserAgent(),
		ClientIp:         gofakeit.IPv4Address(),
		IsBlocked:        false,
		ExpiresAt:        time.Now().Add(24 * time.Hour),
	}

	session, err := testQueries.CreateSession(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, session)

	require.Equal(t, arg.ID, session.ID)
	require.Equal(t, arg.UserID, session.UserID)
	require.Equal(t, arg.Username, session.Username)
	require.Equal(t, arg.RefreshTokenHash, session.RefreshTokenHash)
	require.Equal(t, arg.UserAgent, session.UserAgent)
	require.Equal(t, arg.ClientIp, session.ClientIp)
	require.Equal(t, arg.IsBlocked, session.IsBlocked)
	require.WithinDuration(t, arg.ExpiresAt, session.ExpiresAt, time.Second)
	require.NotZero(t, session.CreatedAt)

	return session
}

func TestCreateSession(t *testing.T) {
	user := createRandomUser(t)
	createRandomSession(t, user)
}

func TestGetSession(t *testing.T) {
	user := createRandomUser(t)
	session1 := createRandomSession(t, user)

	session2, err := testQueries.GetSession(context.Background(), session1.ID)
	require.NoError(t, err)
	require.NotEmpty(t, session2)

	require.Equal(t, session1.ID, session2.ID)
	require.Equal(t, session1.UserID, session2.UserID)
	require.Equal(t, session1.Username, session2.Username)
	require.Equal(t, session1.RefreshTokenHash, session2.RefreshTokenHash)
	require.Equal(t, session1.UserAgent, session2.UserAgent)
	require.Equal(t, session1.ClientIp, session2.ClientIp)
	require.Equal(t, session1.IsBlocked, session2.IsBlocked)
	require.WithinDuration(t, session1.ExpiresAt, session2.ExpiresAt, time.Second)
	require.WithinDuration(t, session1.CreatedAt, session2.CreatedAt, time.Second)
}

func TestGetSessionNotFound(t *testing.T) {
	randomID := uuid.New()

	session, err := testQueries.GetSession(context.Background(), randomID)
	require.Error(t, err)
	require.EqualError(t, err, sql.ErrNoRows.Error())
	require.Empty(t, session)
}

func TestUpdateSession(t *testing.T) {
	user1 := createRandomUser(t)
	user2 := createRandomUser(t)
	session1 := createRandomSession(t, user1)

	arg := UpdateSessionParams{
		ID:       session1.ID,
		Username: user2.Username,
	}

	session2, err := testQueries.UpdateSession(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, session2)

	require.Equal(t, session1.ID, session2.ID)
	require.Equal(t, session1.UserID, session2.UserID)
	require.Equal(t, arg.Username, session2.Username)
	require.Equal(t, session1.RefreshTokenHash, session2.RefreshTokenHash)
	require.Equal(t, session1.UserAgent, session2.UserAgent)
	require.Equal(t, session1.ClientIp, session2.ClientIp)
	require.Equal(t, session1.IsBlocked, session2.IsBlocked)
	require.WithinDuration(t, session1.ExpiresAt, session2.ExpiresAt, time.Second)
	require.WithinDuration(t, session1.CreatedAt, session2.CreatedAt, time.Second)
}

func TestListSessionsByUser(t *testing.T) {
	user := createRandomUser(t)

	var sessions []Session
	for i := 0; i < 5; i++ {
		session := createRandomSession(t, user)
		sessions = append(sessions, session)
	}

	otherUser := createRandomUser(t)
	createRandomSession(t, otherUser)

	userSessions, err := testQueries.ListSessionsByUser(context.Background(), user.ID)
	require.NoError(t, err)
	require.Len(t, userSessions, 5)

	for _, session := range userSessions {
		require.Equal(t, user.ID, session.UserID)
		require.Equal(t, user.Username, session.Username)
	}
}

func TestListSessionsByUsername(t *testing.T) {
	user := createRandomUser(t)

	var sessions []Session
	for i := 0; i < 3; i++ {
		session := createRandomSession(t, user)
		sessions = append(sessions, session)
	}

	otherUser := createRandomUser(t)
	createRandomSession(t, otherUser)

	userSessions, err := testQueries.ListSessionsByUsername(context.Background(), user.Username)
	require.NoError(t, err)
	require.Len(t, userSessions, 3)

	for _, session := range userSessions {
		require.Equal(t, user.ID, session.UserID)
		require.Equal(t, user.Username, session.Username)
	}
}

func TestBlockSession(t *testing.T) {
	user := createRandomUser(t)
	session := createRandomSession(t, user)

	require.False(t, session.IsBlocked)

	err := testQueries.BlockSession(context.Background(), session.ID)
	require.NoError(t, err)

	blockedSession, err := testQueries.GetSession(context.Background(), session.ID)
	require.NoError(t, err)
	require.True(t, blockedSession.IsBlocked)
}

func TestUpdateSessionsUsername(t *testing.T) {
	user := createRandomUser(t)

	newUser := createRandomUser(t)
	newUsername := newUser.Username

	var sessions []Session
	for i := 0; i < 3; i++ {
		session := createRandomSession(t, user)
		sessions = append(sessions, session)
	}

	otherUser := createRandomUser(t)
	otherSession := createRandomSession(t, otherUser)

	arg := UpdateSessionsUsernameParams{
		Username:   user.Username,
		Username_2: newUsername,
	}

	updatedSessions, err := testQueries.UpdateSessionsUsername(context.Background(), arg)
	require.NoError(t, err)
	require.Len(t, updatedSessions, 3)

	for _, session := range updatedSessions {
		require.Equal(t, user.ID, session.UserID)
		require.Equal(t, newUsername, session.Username)
	}

	unchangedSession, err := testQueries.GetSession(context.Background(), otherSession.ID)
	require.NoError(t, err)
	require.Equal(t, otherUser.Username, unchangedSession.Username)
}

func TestCreateSessionWithBlockedStatus(t *testing.T) {
	user := createRandomUser(t)

	arg := CreateSessionParams{
		ID:               uuid.New(),
		UserID:           user.ID,
		Username:         user.Username,
		RefreshTokenHash: []byte(gofakeit.UUID()),
		RefreshKid:       sql.NullString{},
		Jti:              uuid.NullUUID{},
		UserAgent:        gofakeit.UserAgent(),
		ClientIp:         gofakeit.IPv4Address(),
		IsBlocked:        true,
		ExpiresAt:        time.Now().Add(24 * time.Hour),
	}

	session, err := testQueries.CreateSession(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, session)
	require.True(t, session.IsBlocked)
}

func TestCreateSessionWithExpiredTime(t *testing.T) {
	user := createRandomUser(t)

	arg := CreateSessionParams{
		ID:               uuid.New(),
		UserID:           user.ID,
		Username:         user.Username,
		RefreshTokenHash: []byte(gofakeit.UUID()),
		RefreshKid:       sql.NullString{},
		Jti:              uuid.NullUUID{},
		UserAgent:        gofakeit.UserAgent(),
		ClientIp:         gofakeit.IPv4Address(),
		IsBlocked:        false,
		ExpiresAt:        time.Now().Add(-24 * time.Hour),
	}

	session, err := testQueries.CreateSession(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, session)
	require.True(t, session.ExpiresAt.Before(time.Now()))
}
