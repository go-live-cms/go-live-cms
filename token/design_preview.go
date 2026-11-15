package token

import (
	"encoding/json"
	"strconv"
	"time"

	p "aidanwoods.dev/go-paseto"
	"github.com/google/uuid"
)

// Design preview tokens (#486, docs/design/theme-builder.md 8.3 and 12).
//
// An admin previewing the unpublished site design gets one from
// POST /site-design/preview. The Astro server keeps it in an HttpOnly cookie and sends
// it back as the bearer of GET /site-design/draft, the only route that accepts it:
//
//   - v4.public, signed with the access-token key (KID in the footer, so a key rotation's
//     grace window covers it like an access token)
//   - audience DesignPreviewAudience and token_type "design_preview", so VerifyToken
//     (and therefore authMiddleware) rejects it: it is never an API bearer token, and an
//     access token is never a preview token
//   - bound to one theme (the "theme" claim): activating another theme ends the preview
//   - it grants nothing by itself: the draft route checks that its user is still an
//     admin on every read
const (
	// DesignPreviewAudience is the audience claim of design preview tokens.
	DesignPreviewAudience = "golive.design-preview"

	// DesignPreviewType is the token_type claim of design preview tokens.
	DesignPreviewType = "design_preview"
)

// DesignPreviewPayload holds the verified claims of a design preview token.
type DesignPreviewPayload struct {
	ID        uuid.UUID
	UserID    int64
	Theme     string
	IssuedAt  time.Time
	ExpiredAt time.Time
}

// CreateDesignPreviewToken mints a design preview token for one admin and one theme.
func (m *PasetoV4Maker) CreateDesignPreviewToken(userID int64, theme string, dur time.Duration) (string, *DesignPreviewPayload, error) {
	t := p.NewToken()
	now := time.Now()
	id := uuid.New()
	t.SetIssuedAt(now)
	t.SetNotBefore(now.Add(-15 * time.Second))
	t.SetExpiration(now.Add(dur))
	t.SetIssuer(m.keys.Issuer)
	t.SetAudience(DesignPreviewAudience)
	t.SetJti(id.String())
	_ = t.Set("user_id", strconv.FormatInt(userID, 10))
	_ = t.Set("token_type", DesignPreviewType)
	_ = t.Set("theme", theme)

	footer, _ := json.Marshal(map[string]string{"kid": m.keys.AccessKID, "ver": "v4.public"})
	t.SetFooter(footer)

	payload := &DesignPreviewPayload{
		ID:        id,
		UserID:    userID,
		Theme:     theme,
		IssuedAt:  now,
		ExpiredAt: now.Add(dur),
	}
	return t.V4Sign(m.keys.PrivateKey, nil), payload, nil
}

// VerifyDesignPreviewToken checks a design preview token's signature (the key its
// footer KID names), issuer, audience, type and expiry. Whether its user may still
// preview is the caller's check.
func (m *PasetoV4Maker) VerifyDesignPreviewToken(tok string) (*DesignPreviewPayload, error) {
	// Expiry is checked below so it maps to ErrExpiredToken, as in VerifyToken.
	parser := p.NewParserWithoutExpiryCheck()
	parser.AddRule(p.IssuedBy(m.keys.Issuer))
	parser.AddRule(p.ForAudience(DesignPreviewAudience))

	key, ok := m.publicKeyFor(tok)
	if !ok {
		return nil, ErrInvalidTokenV4
	}
	pt, err := parser.ParseV4Public(key, tok, nil)
	if err != nil {
		return nil, ErrInvalidTokenV4
	}
	if tokenType, _ := pt.GetString("token_type"); tokenType != DesignPreviewType {
		return nil, ErrInvalidTokenV4
	}

	var out DesignPreviewPayload
	jti, err := pt.GetJti()
	if err != nil {
		return nil, ErrInvalidTokenV4
	}
	if out.ID, err = uuid.Parse(jti); err != nil {
		return nil, ErrInvalidTokenV4
	}
	userIDStr, err := pt.GetString("user_id")
	if err != nil {
		return nil, ErrInvalidTokenV4
	}
	if out.UserID, err = strconv.ParseInt(userIDStr, 10, 64); err != nil || out.UserID <= 0 {
		return nil, ErrInvalidTokenV4
	}
	if out.Theme, err = pt.GetString("theme"); err != nil || out.Theme == "" {
		return nil, ErrInvalidTokenV4
	}
	if out.ExpiredAt, err = pt.GetExpiration(); err != nil {
		return nil, ErrInvalidTokenV4
	}
	out.IssuedAt, _ = pt.GetIssuedAt()

	if time.Now().After(out.ExpiredAt) {
		return nil, ErrExpiredTokenV4
	}
	return &out, nil
}
