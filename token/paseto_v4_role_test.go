package token

import (
	"testing"
	"time"

	p "aidanwoods.dev/go-paseto"
	"github.com/stretchr/testify/require"
)

func newTestV4Maker(t *testing.T) *PasetoV4Maker {
	priv := p.NewV4AsymmetricSecretKey()
	local := p.NewV4SymmetricKey()

	maker, err := NewPasetoV4Maker(
		priv.ExportHex(), priv.Public().ExportHex(), local.ExportHex(),
		"test.issuer", "test.audience", "access-kid", "refresh-kid",
	)
	require.NoError(t, err)
	return maker
}

// TestV4RoleClaimRoundTrip checks that the informational role claim set at
// login survives verification, and that tokens without it (renewal-issued or
// pre-#187) still verify with an empty Role.
func TestV4RoleClaimRoundTrip(t *testing.T) {
	maker := newTestV4Maker(t)

	withRole, err := maker.CreateTokenWithRole(42, "alice", "editor", time.Minute)
	require.NoError(t, err)

	payload, err := maker.VerifyToken(withRole)
	require.NoError(t, err)
	require.Equal(t, int64(42), payload.UserID)
	require.Equal(t, "alice", payload.Username)
	require.Equal(t, "editor", payload.Role)

	withoutRole, err := maker.CreateToken(42, "alice", time.Minute)
	require.NoError(t, err)

	payload, err = maker.VerifyToken(withoutRole)
	require.NoError(t, err)
	require.Empty(t, payload.Role)
}
