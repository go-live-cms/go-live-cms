package token

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/pem"
	"testing"
	"time"

	p "aidanwoods.dev/go-paseto"
	"github.com/stretchr/testify/require"
)

func TestNewPasetoV4MakerRejectsBadKeys(t *testing.T) {
	priv := p.NewV4AsymmetricSecretKey()
	pubHex := priv.Public().ExportHex()
	privHex := priv.ExportHex()
	localHex := p.NewV4SymmetricKey().ExportHex()

	testCases := []struct {
		name                    string
		privHex, pubHex, locHex string
	}{
		{"BadPrivateKey", "not-hex", pubHex, localHex},
		{"ShortPrivateKey", privHex[:32], pubHex, localHex},
		{"BadPublicKey", privHex, "zz", localHex},
		{"ShortLocalKey", privHex, pubHex, localHex[:16]},
		{"EmptyLocalKey", privHex, pubHex, ""},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			maker, err := NewPasetoV4Maker(tc.privHex, tc.pubHex, tc.locHex, "iss", "aud", "a", "r")
			require.Error(t, err)
			require.Nil(t, maker)
		})
	}
}

// A maker whose public key doesn't match its private key signs tokens it
// can't verify itself; that must fail closed, not open.
func TestV4MismatchedKeyPairFailsClosed(t *testing.T) {
	signer := p.NewV4AsymmetricSecretKey()
	other := p.NewV4AsymmetricSecretKey()
	maker, err := NewPasetoV4Maker(signer.ExportHex(), other.Public().ExportHex(), p.NewV4SymmetricKey().ExportHex(), "iss", "aud", "a", "r")
	require.NoError(t, err)

	tok, err := maker.CreateToken(1, "alice", time.Minute)
	require.NoError(t, err)
	_, err = maker.VerifyToken(tok)
	require.ErrorIs(t, err, ErrInvalidToken)

	ticket, _, err := maker.CreateWSTicket(1, "alice", "post-1", time.Minute)
	require.NoError(t, err)
	_, err = maker.VerifyWSTicket(ticket)
	require.ErrorIs(t, err, ErrInvalidToken)
}

func TestWSTicketWrongIssuerRejected(t *testing.T) {
	maker := newTestV4Maker(t)
	ticket, _, err := maker.CreateWSTicket(42, "alice", "post-7", 30*time.Second)
	require.NoError(t, err)

	verifier := *maker
	verifier.keys.Issuer = "someone-else"
	_, err = verifier.VerifyWSTicket(ticket)
	require.ErrorIs(t, err, ErrInvalidTokenV4)
}

func TestWSTicketTamperedRejected(t *testing.T) {
	maker := newTestV4Maker(t)
	ticket, _, err := maker.CreateWSTicket(42, "alice", "post-7", 30*time.Second)
	require.NoError(t, err)

	// Flip one character of the signed body.
	b := []byte(ticket)
	i := len("v4.public.") + 5
	if b[i] == 'A' {
		b[i] = 'B'
	} else {
		b[i] = 'A'
	}
	_, err = maker.VerifyWSTicket(string(b))
	require.ErrorIs(t, err, ErrInvalidTokenV4)
}

// signTicket signs a ticket-shaped token with maker's key, letting a test
// drop or corrupt individual claims.
func signTicket(t *testing.T, maker *PasetoV4Maker, set func(tok *p.Token)) string {
	t.Helper()
	tok := p.NewToken()
	now := time.Now()
	tok.SetIssuedAt(now)
	tok.SetNotBefore(now.Add(-15 * time.Second))
	tok.SetExpiration(now.Add(time.Minute))
	tok.SetIssuer(maker.keys.Issuer)
	tok.SetAudience(WSTicketAudience)
	set(&tok)
	return tok.V4Sign(maker.keys.PrivateKey, nil)
}

// VerifyWSTicket is the Go reference for websocket/access.js: a correctly
// signed ticket still fails if any claim the WS server relies on is missing
// or malformed.
func TestWSTicketMalformedClaimsRejected(t *testing.T) {
	maker := newTestV4Maker(t)
	const jti = "6f1c1a52-6a0e-4c0f-9c1e-2b7a5d9f0a11"

	testCases := []struct {
		name string
		set  func(tok *p.Token)
	}{
		{"MissingJti", func(tok *p.Token) {
			_ = tok.Set("token_type", WSTicketType)
			_ = tok.Set("user_id", "42")
			_ = tok.Set("doc", "post-7")
		}},
		{"NonUUIDJti", func(tok *p.Token) {
			tok.SetJti("not-a-uuid")
			_ = tok.Set("token_type", WSTicketType)
			_ = tok.Set("user_id", "42")
			_ = tok.Set("doc", "post-7")
		}},
		{"MissingUserID", func(tok *p.Token) {
			tok.SetJti(jti)
			_ = tok.Set("token_type", WSTicketType)
			_ = tok.Set("doc", "post-7")
		}},
		{"NonNumericUserID", func(tok *p.Token) {
			tok.SetJti(jti)
			_ = tok.Set("token_type", WSTicketType)
			_ = tok.Set("user_id", "42abc")
			_ = tok.Set("doc", "post-7")
		}},
		{"MissingDoc", func(tok *p.Token) {
			tok.SetJti(jti)
			_ = tok.Set("token_type", WSTicketType)
			_ = tok.Set("user_id", "42")
		}},
		{"EmptyDoc", func(tok *p.Token) {
			tok.SetJti(jti)
			_ = tok.Set("token_type", WSTicketType)
			_ = tok.Set("user_id", "42")
			_ = tok.Set("doc", "")
		}},
		{"AccessTokenType", func(tok *p.Token) {
			tok.SetJti(jti)
			_ = tok.Set("token_type", "access")
			_ = tok.Set("user_id", "42")
			_ = tok.Set("doc", "post-7")
		}},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := maker.VerifyWSTicket(signTicket(t, maker, tc.set))
			require.ErrorIs(t, err, ErrInvalidTokenV4)
		})
	}

	t.Run("AllClaimsPresent", func(t *testing.T) {
		payload, err := maker.VerifyWSTicket(signTicket(t, maker, func(tok *p.Token) {
			tok.SetJti(jti)
			_ = tok.Set("token_type", WSTicketType)
			_ = tok.Set("user_id", "42")
			_ = tok.Set("doc", "post-7")
		}))
		require.NoError(t, err)
		require.Equal(t, int64(42), payload.UserID)
	})
}

// The WS server verifies tickets with the PEM this exports; it must be the
// maker's real Ed25519 public key in standard SPKI form.
func TestGetPublicKeyPEM(t *testing.T) {
	maker := newTestV4Maker(t)

	pemStr, err := maker.GetPublicKeyPEM()
	require.NoError(t, err)

	block, rest := pem.Decode([]byte(pemStr))
	require.NotNil(t, block)
	require.Empty(t, rest)
	require.Equal(t, "PUBLIC KEY", block.Type)

	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	require.NoError(t, err)
	edKey, ok := parsed.(ed25519.PublicKey)
	require.True(t, ok, "expected an Ed25519 key, got %T", parsed)
	require.Equal(t, maker.keys.PublicKey.ExportBytes(), []byte(edKey))
}

func TestHashRefresh(t *testing.T) {
	want := sha256.Sum256([]byte("refresh-token"))
	require.Equal(t, want[:], HashRefresh("refresh-token"))
	require.Len(t, HashRefresh(""), sha256.Size)
	require.NotEqual(t, HashRefresh("a"), HashRefresh("b"))
}
