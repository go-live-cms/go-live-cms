package token

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestDesignPreviewTokenRoundTrip(t *testing.T) {
	maker := newTestV4Maker(t)

	tok, minted, err := maker.CreateDesignPreviewToken(42, "default", 15*time.Minute)
	require.NoError(t, err)

	payload, err := maker.VerifyDesignPreviewToken(tok)
	require.NoError(t, err)
	require.Equal(t, minted.ID, payload.ID)
	require.Equal(t, int64(42), payload.UserID)
	require.Equal(t, "default", payload.Theme)
	require.WithinDuration(t, minted.ExpiredAt, payload.ExpiredAt, time.Second)
	require.WithinDuration(t, minted.IssuedAt, payload.IssuedAt, time.Second)
}

// A preview token is never an access token or a collab ticket, and neither of those is a
// preview token, even when the API's audience is configured as the preview audience.
func TestDesignPreviewTokenNotInterchangeable(t *testing.T) {
	for _, audience := range []string{"", DesignPreviewAudience} {
		maker := newTestV4Maker(t)
		if audience != "" {
			maker.keys.Audience = audience
		}

		preview, _, err := maker.CreateDesignPreviewToken(42, "default", time.Minute)
		require.NoError(t, err)
		_, err = maker.VerifyToken(preview)
		require.ErrorIs(t, err, ErrInvalidTokenV4)
		_, err = maker.VerifyWSTicket(preview)
		require.ErrorIs(t, err, ErrInvalidTokenV4)

		access, err := maker.CreateToken(42, "alice", time.Minute)
		require.NoError(t, err)
		_, err = maker.VerifyDesignPreviewToken(access)
		require.ErrorIs(t, err, ErrInvalidTokenV4)

		ticket, _, err := maker.CreateWSTicket(42, "alice", "post-7", time.Minute)
		require.NoError(t, err)
		_, err = maker.VerifyDesignPreviewToken(ticket)
		require.ErrorIs(t, err, ErrInvalidTokenV4)
	}
}

func TestDesignPreviewTokenExpired(t *testing.T) {
	maker := newTestV4Maker(t)
	tok, _, err := maker.CreateDesignPreviewToken(42, "default", -time.Second)
	require.NoError(t, err)
	_, err = maker.VerifyDesignPreviewToken(tok)
	require.ErrorIs(t, err, ErrExpiredTokenV4)
}

func TestDesignPreviewTokenRejected(t *testing.T) {
	maker := newTestV4Maker(t)

	other, _, err := newTestV4Maker(t).CreateDesignPreviewToken(42, "default", time.Minute)
	require.NoError(t, err)
	_, err = maker.VerifyDesignPreviewToken(other)
	require.ErrorIs(t, err, ErrInvalidTokenV4, "signed with another key")

	noTheme, _, err := maker.CreateDesignPreviewToken(42, "", time.Minute)
	require.NoError(t, err)
	_, err = maker.VerifyDesignPreviewToken(noTheme)
	require.ErrorIs(t, err, ErrInvalidTokenV4, "no theme")

	noUser, _, err := maker.CreateDesignPreviewToken(0, "default", time.Minute)
	require.NoError(t, err)
	_, err = maker.VerifyDesignPreviewToken(noUser)
	require.ErrorIs(t, err, ErrInvalidTokenV4, "no user")

	for _, garbage := range []string{"", "v4.public.", "not a token"} {
		_, err = maker.VerifyDesignPreviewToken(garbage)
		require.ErrorIs(t, err, ErrInvalidTokenV4, garbage)
	}
}
