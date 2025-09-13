package token

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	p "aidanwoods.dev/go-paseto"
	"github.com/google/uuid"
)

type V4Keys struct {
	PrivateKey p.V4AsymmetricSecretKey
	PublicKey  p.V4AsymmetricPublicKey
	LocalKey   p.V4SymmetricKey
	AccessKID  string
	RefreshKID string
	Issuer     string
	Audience   string
}

type PasetoV4Maker struct {
	keys V4Keys
}

func NewPasetoV4Maker(privHex, pubHex, localHex, iss, aud, accessKID, refreshKID string) (*PasetoV4Maker, error) {
	priv, err := p.NewV4AsymmetricSecretKeyFromHex(privHex)
	if err != nil {
		return nil, err
	}
	pub, err := p.NewV4AsymmetricPublicKeyFromHex(pubHex)
	if err != nil {
		return nil, err
	}
	lk, err := p.V4SymmetricKeyFromHex(localHex)
	if err != nil {
		return nil, err
	}

	return &PasetoV4Maker{
		keys: V4Keys{
			PrivateKey: priv, PublicKey: pub, LocalKey: lk,
			AccessKID: accessKID, RefreshKID: refreshKID,
			Issuer: iss, Audience: aud,
		},
	}, nil
}

func (m *PasetoV4Maker) CreateToken(userID int64, username string, dur time.Duration) (string, error) {
	t := p.NewToken()
	now := time.Now()
	t.SetIssuedAt(now)
	t.SetNotBefore(now)
	t.SetExpiration(now.Add(dur))
	t.SetIssuer(m.keys.Issuer)
	t.SetAudience(m.keys.Audience)
	t.SetSubject(username)
	t.SetJti(uuid.NewString())
	_ = t.Set("user_id", strconv.FormatInt(userID, 10))
	_ = t.Set("username", username)
	_ = t.Set("token_type", "access")

	footer, _ := json.Marshal(map[string]string{"kid": m.keys.AccessKID, "ver": "v4.public"})
	t.SetFooter(footer)

	return t.V4Sign(m.keys.PrivateKey, nil), nil
}

func (m *PasetoV4Maker) CreateRefreshToken(userID int64, username string, dur time.Duration) (string, error) {
	t := p.NewToken()
	now := time.Now()
	t.SetIssuedAt(now)
	t.SetNotBefore(now)
	t.SetExpiration(now.Add(dur))
	t.SetIssuer(m.keys.Issuer)
	t.SetAudience(m.keys.Audience)
	t.SetSubject(username)
	t.SetJti(uuid.NewString())
	_ = t.Set("user_id", strconv.FormatInt(userID, 10))
	_ = t.Set("username", username)
	_ = t.Set("token_type", "refresh")

	footer, _ := json.Marshal(map[string]string{"kid": m.keys.RefreshKID, "ver": "v4.local"})
	t.SetFooter(footer)

	return t.V4Encrypt(m.keys.LocalKey, nil), nil
}

var (
	ErrInvalidTokenV4 = errors.New("token is invalid")
	ErrExpiredTokenV4 = errors.New("token has expired")
)

func (m *PasetoV4Maker) VerifyToken(tok string) (*Payload, error) {
	parser := p.NewParser()
	parser.AddRule(p.IssuedBy(m.keys.Issuer))
	parser.AddRule(p.ForAudience(m.keys.Audience))

	pt, err := parser.ParseV4Public(m.keys.PublicKey, tok, nil)
	if err != nil {
		return nil, ErrInvalidTokenV4
	}

	var out Payload
	out.IssuedAt, _ = pt.GetIssuedAt()
	out.ExpiredAt, _ = pt.GetExpiration()
	out.Username, _ = pt.GetString("username")
	out.TokenType, _ = pt.GetString("token_type")

	if out.TokenType != "access" {
		return nil, ErrInvalidTokenV4
	}

	if jti, err := pt.GetJti(); err == nil {
		if id, err := uuid.Parse(jti); err == nil {
			out.ID = id
		}
	}

	if userIDStr, err := pt.GetString("user_id"); err == nil {
		if i, e := strconv.ParseInt(userIDStr, 10, 64); e == nil {
			out.UserID = i
		}
	}

	if time.Now().After(out.ExpiredAt) {
		return nil, ErrExpiredTokenV4
	}
	return &out, nil
}

func (m *PasetoV4Maker) ParseRefresh(tok string) (*p.Token, error) {
	parser := p.NewParser()
	parser.AddRule(p.IssuedBy(m.keys.Issuer))
	parser.AddRule(p.ForAudience(m.keys.Audience))
	return parser.ParseV4Local(m.keys.LocalKey, tok, nil)
}

// Helpers
func HashRefresh(token string) []byte {
	h := sha256.Sum256([]byte(token))
	return h[:]
}

func HashToHex(b []byte) string {
	return hex.EncodeToString(b)
}

func EqualHash(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var result byte
	for i := 0; i < len(a); i++ {
		result |= a[i] ^ b[i]
	}
	return result == 0
}
