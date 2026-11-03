package token

import (
	"encoding/json"
	"testing"
	"time"

	p "aidanwoods.dev/go-paseto"
	"github.com/stretchr/testify/require"
)

type testKeys struct {
	priv       p.V4AsymmetricSecretKey
	local      p.V4SymmetricKey
	accessKID  string
	refreshKID string
}

// newTestKeys returns a fresh key set whose KIDs end in generation, as a
// rotation would name them.
func newTestKeys(generation string) testKeys {
	return testKeys{
		priv: p.NewV4AsymmetricSecretKey(), local: p.NewV4SymmetricKey(),
		accessKID: "k4.pub." + generation, refreshKID: "k4.loc." + generation,
	}
}

func (k testKeys) maker(t *testing.T) *PasetoV4Maker {
	t.Helper()
	m, err := NewPasetoV4Maker(k.priv.ExportHex(), k.priv.Public().ExportHex(), k.local.ExportHex(),
		"iss", "aud", k.accessKID, k.refreshKID)
	require.NoError(t, err)
	return m
}

// previousOf returns k as the previous-key maps SetPreviousKeys takes.
func (k testKeys) previousOf() (public, local map[string]string) {
	return map[string]string{k.accessKID: k.priv.Public().ExportHex()},
		map[string]string{k.refreshKID: k.local.ExportHex()}
}

func requireFooterKID(t *testing.T, protocol p.Protocol, tok, want string) {
	t.Helper()
	kid, ok := footerKID(protocol, tok)
	require.True(t, ok)
	require.Equal(t, want, kid)
}

func TestPreviousKeysVerifyDuringGraceWindow(t *testing.T) {
	oldKeys, newKeys := newTestKeys("2026-01"), newTestKeys("2026-11")

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

	// Within the grace window both still verify, by their KID.
	public, local := oldKeys.previousOf()
	require.NoError(t, rotated.SetPreviousKeys(public, local, time.Now().Add(time.Hour)))
	payload, err := rotated.VerifyToken(access)
	require.NoError(t, err)
	require.Equal(t, int64(7), payload.UserID)
	parsed, err := rotated.ParseRefresh(refresh)
	require.NoError(t, err)
	userID, err := parsed.GetString("user_id")
	require.NoError(t, err)
	require.Equal(t, "7", userID)

	// New tokens are signed with the current keys only, and say so.
	current, err := rotated.CreateToken(8, "bob", time.Minute)
	require.NoError(t, err)
	requireFooterKID(t, p.V4Public, current, newKeys.accessKID)
	_, err = rotated.VerifyToken(current)
	require.NoError(t, err)
	_, err = oldKeys.maker(t).VerifyToken(current)
	require.ErrorIs(t, err, ErrInvalidToken, "not signed with the old key")
	currentRefresh, err := rotated.CreateRefreshToken(8, "bob", time.Hour)
	require.NoError(t, err)
	requireFooterKID(t, p.V4Local, currentRefresh, newKeys.refreshKID)
	_, err = oldKeys.maker(t).ParseRefresh(currentRefresh)
	require.Error(t, err, "not encrypted with the old key")

	// After the window the previous keys are ignored.
	require.NoError(t, rotated.SetPreviousKeys(public, local, time.Now().Add(-time.Second)))
	_, err = rotated.VerifyToken(access)
	require.ErrorIs(t, err, ErrInvalidToken)
	_, err = rotated.ParseRefresh(refresh)
	require.Error(t, err)
}

// Two rotations inside one grace window: tokens of both retired generations
// keep verifying, each with its own key.
func TestPreviousKeysSeveralGenerations(t *testing.T) {
	first, second, third := newTestKeys("2026-01"), newTestKeys("2026-06"), newTestKeys("2026-11")
	accessFirst, err := first.maker(t).CreateToken(1, "a", time.Minute)
	require.NoError(t, err)
	accessSecond, err := second.maker(t).CreateToken(2, "b", time.Minute)
	require.NoError(t, err)
	refreshFirst, err := first.maker(t).CreateRefreshToken(1, "a", time.Hour)
	require.NoError(t, err)
	refreshSecond, err := second.maker(t).CreateRefreshToken(2, "b", time.Hour)
	require.NoError(t, err)

	rotated := third.maker(t)
	pub1, loc1 := first.previousOf()
	pub2, loc2 := second.previousOf()
	for kid, hex := range pub2 {
		pub1[kid] = hex
	}
	for kid, hex := range loc2 {
		loc1[kid] = hex
	}
	require.NoError(t, rotated.SetPreviousKeys(pub1, loc1, time.Now().Add(time.Hour)))

	for want, tok := range map[int64]string{1: accessFirst, 2: accessSecond} {
		payload, err := rotated.VerifyToken(tok)
		require.NoError(t, err)
		require.Equal(t, want, payload.UserID)
	}
	for _, tok := range []string{refreshFirst, refreshSecond} {
		_, err := rotated.ParseRefresh(tok)
		require.NoError(t, err)
	}
}

// The KID chooses the key: a token is never tried against another one. An
// old-key token whose KID was swapped for the current one (or for another
// previous one) is rejected, and so is a token with an unknown or no KID,
// even if a configured key would have verified it.
func TestPreviousKeysAreChosenByKID(t *testing.T) {
	oldKeys, newKeys := newTestKeys("2026-01"), newTestKeys("2026-11")
	public, local := oldKeys.previousOf()

	// Old keys, but minted under the new KIDs: the KID picks the new key.
	mislabelled := oldKeys
	mislabelled.accessKID, mislabelled.refreshKID = newKeys.accessKID, newKeys.refreshKID
	access, err := mislabelled.maker(t).CreateToken(7, "alice", time.Minute)
	require.NoError(t, err)
	refresh, err := mislabelled.maker(t).CreateRefreshToken(7, "alice", time.Hour)
	require.NoError(t, err)

	rotated := newKeys.maker(t)
	require.NoError(t, rotated.SetPreviousKeys(public, local, time.Now().Add(time.Hour)))
	_, err = rotated.VerifyToken(access)
	require.ErrorIs(t, err, ErrInvalidToken)
	_, err = rotated.ParseRefresh(refresh)
	require.Error(t, err)

	// A KID nobody knows, with a key that is configured under another KID.
	unknown := oldKeys
	unknown.accessKID, unknown.refreshKID = "k4.pub.unknown", "k4.loc.unknown"
	access, err = unknown.maker(t).CreateToken(7, "alice", time.Minute)
	require.NoError(t, err)
	refresh, err = unknown.maker(t).CreateRefreshToken(7, "alice", time.Hour)
	require.NoError(t, err)
	_, err = rotated.VerifyToken(access)
	require.ErrorIs(t, err, ErrInvalidToken)
	_, err = rotated.ParseRefresh(refresh)
	require.Error(t, err)

	// No footer at all, signed with the current keys.
	bare := p.NewToken()
	bare.SetIssuer("iss")
	bare.SetAudience("aud")
	bare.SetExpiration(time.Now().Add(time.Minute))
	_ = bare.Set("token_type", "access")
	_, err = rotated.VerifyToken(bare.V4Sign(newKeys.priv, nil))
	require.ErrorIs(t, err, ErrInvalidToken)
	_ = bare.Set("token_type", "refresh")
	_, err = rotated.ParseRefresh(bare.V4Encrypt(newKeys.local, nil))
	require.Error(t, err)

	// A footer that isn't JSON or has an empty kid.
	_ = bare.Set("token_type", "access")
	for _, footer := range []string{"not json", `{"kid":""}`} {
		bare.SetFooter([]byte(footer))
		_, err = rotated.VerifyToken(bare.V4Sign(newKeys.priv, nil))
		require.ErrorIs(t, err, ErrInvalidToken, footer)
	}
}

// Rotating only the access key (or only the refresh key) keeps the other.
func TestPreviousKeysOnlyTheRotatedOne(t *testing.T) {
	oldKeys := newTestKeys("2026-01")
	refresh, err := oldKeys.maker(t).CreateRefreshToken(7, "alice", time.Hour)
	require.NoError(t, err)

	// Only the public key rotated: old refresh tokens still fail with a new
	// local key and a new refresh KID.
	newKeys := newTestKeys("2026-11")
	rotated := newKeys.maker(t)
	public, _ := oldKeys.previousOf()
	require.NoError(t, rotated.SetPreviousKeys(public, nil, time.Now().Add(time.Hour)))
	_, err = rotated.ParseRefresh(refresh)
	require.Error(t, err)

	// The local key and its KID unchanged: refresh tokens keep working.
	accessOnly := newKeys
	accessOnly.local, accessOnly.refreshKID = oldKeys.local, oldKeys.refreshKID
	rotated = accessOnly.maker(t)
	require.NoError(t, rotated.SetPreviousKeys(public, nil, time.Now().Add(time.Hour)))
	_, err = rotated.ParseRefresh(refresh)
	require.NoError(t, err)
}

func TestPreviousKeysStillCheckExpiryAndType(t *testing.T) {
	oldKeys, newKeys := newTestKeys("2026-01"), newTestKeys("2026-11")
	expired, err := oldKeys.maker(t).CreateToken(7, "alice", -time.Minute)
	require.NoError(t, err)

	rotated := newKeys.maker(t)
	public, _ := oldKeys.previousOf()
	require.NoError(t, rotated.SetPreviousKeys(public, nil, time.Now().Add(time.Hour)))
	_, err = rotated.VerifyToken(expired)
	require.ErrorIs(t, err, ErrExpiredToken)

	// A collab ticket signed with the old key is not accepted as an access token.
	ticket, _, err := oldKeys.maker(t).CreateWSTicket(7, "alice", "post-1", 30*time.Second)
	require.NoError(t, err)
	_, err = rotated.VerifyToken(ticket)
	require.ErrorIs(t, err, ErrInvalidToken)
}

func TestSetPreviousKeysValidation(t *testing.T) {
	keys := newTestKeys("2026-11")
	m := keys.maker(t)
	other := newTestKeys("2026-01")
	public, local := other.previousOf()
	soon := time.Now().Add(time.Hour)

	require.Error(t, m.SetPreviousKeys(public, nil, time.Time{}), "needs an end of window")
	require.ErrorContains(t, m.SetPreviousKeys(map[string]string{"k": "zz"}, nil, soon), `"k"`)
	require.ErrorContains(t, m.SetPreviousKeys(nil, map[string]string{"k": "zz"}, soon), `"k"`)
	require.ErrorContains(t, m.SetPreviousKeys(map[string]string{"": other.priv.Public().ExportHex()}, nil, soon), "needs a KID")
	require.ErrorContains(t, m.SetPreviousKeys(nil, map[string]string{"": other.local.ExportHex()}, soon), "needs a KID")

	// The current KID can't name a previous key: it would be ambiguous.
	err := m.SetPreviousKeys(map[string]string{keys.accessKID: other.priv.Public().ExportHex()}, nil, soon)
	require.ErrorContains(t, err, "current access KID")
	err = m.SetPreviousKeys(nil, map[string]string{keys.refreshKID: other.local.ExportHex()}, soon)
	require.ErrorContains(t, err, "current refresh KID")

	// A failed call keeps no partial state.
	require.Nil(t, m.previous)
	require.NoError(t, m.SetPreviousKeys(public, local, soon))
	require.NotNil(t, m.previous)
	require.NoError(t, m.SetPreviousKeys(nil, nil, time.Time{}), "both empty clears")
	require.Nil(t, m.previous)
}

// Tokens carry {"kid", "ver"} in the footer, the shape footerKID reads.
func TestFooterCarriesKID(t *testing.T) {
	keys := newTestKeys("2026-11")
	m := keys.maker(t)
	access, err := m.CreateToken(1, "a", time.Minute)
	require.NoError(t, err)
	raw, err := p.NewParser().UnsafeParseFooter(p.V4Public, access)
	require.NoError(t, err)
	var footer map[string]string
	require.NoError(t, json.Unmarshal(raw, &footer))
	require.Equal(t, map[string]string{"kid": keys.accessKID, "ver": "v4.public"}, footer)

	_, ok := footerKID(p.V4Public, "v4.public.garbage")
	require.False(t, ok)
	_, ok = footerKID(p.V4Local, access)
	require.False(t, ok, "wrong protocol")
}
