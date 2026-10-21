package token

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestV4AccessTokenRoundTrip(t *testing.T) {
	maker := newTestV4Maker(t)

	tok, err := maker.CreateToken(42, "alice", time.Minute)
	require.NoError(t, err)
	require.Contains(t, tok, "v4.public.")

	payload, err := maker.VerifyToken(tok)
	require.NoError(t, err)
	require.NotZero(t, payload.ID)
	require.Equal(t, int64(42), payload.UserID)
	require.Equal(t, "alice", payload.Username)
	require.Equal(t, "access", payload.TokenType)
	require.WithinDuration(t, time.Now().Add(time.Minute), payload.ExpiredAt, 2*time.Second)
}

// Expiry must surface as ErrExpiredToken (the Maker contract), not as a
// generic invalid token, so callers can tell "refresh" from "re-authenticate".
func TestV4ExpiredAccessToken(t *testing.T) {
	maker := newTestV4Maker(t)

	tok, err := maker.CreateToken(42, "alice", -time.Minute)
	require.NoError(t, err)

	_, err = maker.VerifyToken(tok)
	require.ErrorIs(t, err, ErrExpiredToken)
	require.ErrorIs(t, err, ErrExpiredTokenV4)
}

func TestV4AccessTokenFromOtherKeyRejected(t *testing.T) {
	tok, err := newTestV4Maker(t).CreateToken(42, "alice", time.Minute)
	require.NoError(t, err)

	_, err = newTestV4Maker(t).VerifyToken(tok)
	require.ErrorIs(t, err, ErrInvalidToken)
}

// A forged token must be rejected as invalid even when it is also expired:
// the signature is checked before expiry.
func TestV4ExpiredTokenFromOtherKeyIsInvalid(t *testing.T) {
	tok, err := newTestV4Maker(t).CreateToken(42, "alice", -time.Minute)
	require.NoError(t, err)

	_, err = newTestV4Maker(t).VerifyToken(tok)
	require.ErrorIs(t, err, ErrInvalidToken)
}

func TestV4TamperedAccessTokenRejected(t *testing.T) {
	maker := newTestV4Maker(t)

	tok, err := maker.CreateToken(42, "alice", time.Minute)
	require.NoError(t, err)

	// Change a character inside the body; the last one can carry only padding
	// bits that base64 decoding discards.
	i := len("v4.public.") + 10
	flipped := byte('A')
	if tok[i] == 'A' {
		flipped = 'B'
	}
	_, err = maker.VerifyToken(tok[:i] + string(flipped) + tok[i+1:])
	require.ErrorIs(t, err, ErrInvalidToken)

	_, err = maker.VerifyToken("not-a-token")
	require.ErrorIs(t, err, ErrInvalidToken)
}

func TestV4AccessTokenWrongIssuerOrAudienceRejected(t *testing.T) {
	maker := newTestV4Maker(t)
	tok, err := maker.CreateToken(42, "alice", time.Minute)
	require.NoError(t, err)

	maker.keys.Issuer = "other.issuer"
	_, err = maker.VerifyToken(tok)
	require.ErrorIs(t, err, ErrInvalidToken)

	maker.keys.Issuer = "test.issuer"
	maker.keys.Audience = "other.audience"
	_, err = maker.VerifyToken(tok)
	require.ErrorIs(t, err, ErrInvalidToken)
}

func TestV4RefreshTokenRoundTrip(t *testing.T) {
	maker := newTestV4Maker(t)

	tok, err := maker.CreateRefreshToken(42, "alice", time.Hour)
	require.NoError(t, err)
	require.Contains(t, tok, "v4.local.")

	pt, err := maker.ParseRefresh(tok)
	require.NoError(t, err)
	userID, err := pt.GetString("user_id")
	require.NoError(t, err)
	require.Equal(t, "42", userID)
}

func TestV4ExpiredRefreshTokenRejected(t *testing.T) {
	maker := newTestV4Maker(t)

	tok, err := maker.CreateRefreshToken(42, "alice", -time.Minute)
	require.NoError(t, err)

	_, err = maker.ParseRefresh(tok)
	require.Error(t, err)
}

func TestV4RefreshTokenFromOtherKeyRejected(t *testing.T) {
	tok, err := newTestV4Maker(t).CreateRefreshToken(42, "alice", time.Hour)
	require.NoError(t, err)

	_, err = newTestV4Maker(t).ParseRefresh(tok)
	require.Error(t, err)
}

// Access and refresh tokens use different key types and must not be
// accepted in each other's place.
func TestV4AccessAndRefreshTokensAreNotInterchangeable(t *testing.T) {
	maker := newTestV4Maker(t)

	refresh, err := maker.CreateRefreshToken(42, "alice", time.Hour)
	require.NoError(t, err)
	_, err = maker.VerifyToken(refresh)
	require.ErrorIs(t, err, ErrInvalidToken)

	access, err := maker.CreateToken(42, "alice", time.Minute)
	require.NoError(t, err)
	_, err = maker.ParseRefresh(access)
	require.Error(t, err)
}
