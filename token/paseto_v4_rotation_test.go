package token

import (
	"testing"
	"time"

	p "aidanwoods.dev/go-paseto"
	"github.com/stretchr/testify/require"
)

type testKeys struct {
	priv  p.V4AsymmetricSecretKey
	local p.V4SymmetricKey
}

func newTestKeys() testKeys {
	return testKeys{priv: p.NewV4AsymmetricSecretKey(), local: p.NewV4SymmetricKey()}
}

func (k testKeys) maker(t *testing.T) *PasetoV4Maker {
	t.Helper()
	m, err := NewPasetoV4Maker(k.priv.ExportHex(), k.priv.Public().ExportHex(), k.local.ExportHex(),
		"iss", "aud", "access-kid", "refresh-kid")
	require.NoError(t, err)
	return m
}

func TestPreviousKeysVerifyDuringGraceWindow(t *testing.T) {
	oldKeys, newKeys := newTestKeys(), newTestKeys()

	access, err := oldKeys.maker(t).CreateToken(7, "alice", time.Minute)
	require.NoError(t, err)
	refresh, err := oldKeys.maker(t).CreateRefreshToken(7, "alice", time.Hour)
	require.NoError(t, err)

	rotated := newKeys.maker(t)

	// Without previous keys the old tokens are rejected.
	_, err = rotated.VerifyToken(access)
	require.ErrorIs(t, err, ErrInvalidToken)
	_, err = rotated.ParseRefresh(refresh)
	require.Error(t, err)

	// Within the grace window both still verify.
	require.NoError(t, rotated.SetPreviousKeys(oldKeys.priv.Public().ExportHex(), oldKeys.local.ExportHex(), time.Now().Add(time.Hour)))
	payload, err := rotated.VerifyToken(access)
	require.NoError(t, err)
	require.Equal(t, int64(7), payload.UserID)
	parsed, err := rotated.ParseRefresh(refresh)
	require.NoError(t, err)
	userID, err := parsed.GetString("user_id")
	require.NoError(t, err)
	require.Equal(t, "7", userID)

	// Tokens from the current keys are unaffected.
	current, err := rotated.CreateToken(8, "bob", time.Minute)
	require.NoError(t, err)
	_, err = rotated.VerifyToken(current)
	require.NoError(t, err)

	// After the window the previous keys are ignored.
	require.NoError(t, rotated.SetPreviousKeys(oldKeys.priv.Public().ExportHex(), oldKeys.local.ExportHex(), time.Now().Add(-time.Second)))
	_, err = rotated.VerifyToken(access)
	require.ErrorIs(t, err, ErrInvalidToken)
	_, err = rotated.ParseRefresh(refresh)
	require.Error(t, err)
}

func TestPreviousKeysOnlyTheRotatedOne(t *testing.T) {
	oldKeys, newKeys := newTestKeys(), newTestKeys()
	refresh, err := oldKeys.maker(t).CreateRefreshToken(7, "alice", time.Hour)
	require.NoError(t, err)

	// Only the public key rotated: old refresh tokens still fail.
	rotated := newKeys.maker(t)
	require.NoError(t, rotated.SetPreviousKeys(oldKeys.priv.Public().ExportHex(), "", time.Now().Add(time.Hour)))
	_, err = rotated.ParseRefresh(refresh)
	require.Error(t, err)
}

func TestPreviousKeysStillCheckExpiryAndType(t *testing.T) {
	oldKeys, newKeys := newTestKeys(), newTestKeys()
	expired, err := oldKeys.maker(t).CreateToken(7, "alice", -time.Minute)
	require.NoError(t, err)

	rotated := newKeys.maker(t)
	require.NoError(t, rotated.SetPreviousKeys(oldKeys.priv.Public().ExportHex(), "", time.Now().Add(time.Hour)))
	_, err = rotated.VerifyToken(expired)
	require.ErrorIs(t, err, ErrExpiredToken)

	// A collab ticket signed with the old key is not accepted as an access token.
	ticket, _, err := oldKeys.maker(t).CreateWSTicket(7, "alice", "post-1", 30*time.Second)
	require.NoError(t, err)
	_, err = rotated.VerifyToken(ticket)
	require.ErrorIs(t, err, ErrInvalidToken)
}

func TestSetPreviousKeysValidation(t *testing.T) {
	m := newTestKeys().maker(t)
	other := newTestKeys()

	require.Error(t, m.SetPreviousKeys(other.priv.Public().ExportHex(), "", time.Time{}), "needs an end of window")
	require.Error(t, m.SetPreviousKeys("zz", "", time.Now().Add(time.Hour)))
	require.Error(t, m.SetPreviousKeys("", "zz", time.Now().Add(time.Hour)))
	require.NoError(t, m.SetPreviousKeys("", "", time.Time{}), "both empty clears")
	require.Nil(t, m.previous)
}
