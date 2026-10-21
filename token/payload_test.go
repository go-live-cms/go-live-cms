package token

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestNewPayload(t *testing.T) {
	payload, err := NewPayload(42, "alice", time.Minute, "access")
	require.NoError(t, err)
	require.NotZero(t, payload.ID)
	require.Equal(t, int64(42), payload.UserID)
	require.Equal(t, "alice", payload.Username)
	require.Equal(t, "access", payload.TokenType)
	require.WithinDuration(t, time.Now(), payload.IssuedAt, time.Second)
	require.WithinDuration(t, time.Now().Add(time.Minute), payload.ExpiredAt, time.Second)

	other, err := NewPayload(42, "alice", time.Minute, "access")
	require.NoError(t, err)
	require.NotEqual(t, payload.ID, other.ID)
}

func TestPayloadValid(t *testing.T) {
	payload, err := NewPayload(42, "alice", time.Minute, "access")
	require.NoError(t, err)
	require.NoError(t, payload.Valid())

	expired, err := NewPayload(42, "alice", -time.Minute, "access")
	require.NoError(t, err)
	require.ErrorIs(t, expired.Valid(), ErrExpiredToken)
}
