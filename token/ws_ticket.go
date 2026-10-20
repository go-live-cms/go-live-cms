package token

import (
	"encoding/json"
	"strconv"
	"time"

	p "aidanwoods.dev/go-paseto"
	"github.com/google/uuid"
)

// Collaboration (WebSocket) tickets.
//
// The collab socket can't carry an Authorization header (browsers don't allow
// custom headers on a WebSocket handshake), so the credential travels in the
// URL. A URL ends up in every proxy and load balancer access log in front of
// the collab server, so it must never hold the access token itself. Instead
// the editor exchanges its access token for a ticket right before each
// connect:
//
//   - v4.public, signed with the access-token key, so the collab server can
//     check it locally before calling the API
//   - audience WSTicketAudience and token_type "ws_ticket", so VerifyToken
//     (and therefore authMiddleware) rejects it: a ticket is never an API
//     bearer token
//   - bound to one collab document (the "doc" claim)
//   - short-lived; the collab server burns its jti on first use (single use)
//     and looks up the user's current role on the API's internal listener
const (
	// WSTicketAudience is the audience claim of collab tickets. The collab
	// server accepts only this audience.
	WSTicketAudience = "golive.admin-ws"

	// WSTicketType is the token_type claim of collab tickets.
	WSTicketType = "ws_ticket"
)

// WSTicketPayload holds the verified claims of a collab ticket.
type WSTicketPayload struct {
	ID        uuid.UUID
	UserID    int64
	Username  string
	Doc       string
	IssuedAt  time.Time
	ExpiredAt time.Time
}

// CreateWSTicket mints a collab ticket for one user and one document.
func (m *PasetoV4Maker) CreateWSTicket(userID int64, username, doc string, dur time.Duration) (string, *WSTicketPayload, error) {
	t := p.NewToken()
	now := time.Now()
	id := uuid.New()
	t.SetIssuedAt(now)
	t.SetNotBefore(now.Add(-15 * time.Second))
	t.SetExpiration(now.Add(dur))
	t.SetIssuer(m.keys.Issuer)
	t.SetAudience(WSTicketAudience)
	t.SetSubject(username)
	t.SetJti(id.String())
	_ = t.Set("user_id", strconv.FormatInt(userID, 10))
	_ = t.Set("username", username)
	_ = t.Set("token_type", WSTicketType)
	_ = t.Set("doc", doc)

	footer, _ := json.Marshal(map[string]string{"kid": m.keys.AccessKID, "ver": "v4.public"})
	t.SetFooter(footer)

	payload := &WSTicketPayload{
		ID:        id,
		UserID:    userID,
		Username:  username,
		Doc:       doc,
		IssuedAt:  now,
		ExpiredAt: now.Add(dur),
	}
	return t.V4Sign(m.keys.PrivateKey, nil), payload, nil
}

// VerifyWSTicket checks a collab ticket's signature, issuer, audience, type
// and expiry. It does NOT enforce single use (the collab server does). The
// API itself never accepts tickets; this is the Go reference for the checks
// websocket/access.js verifyTicket makes, used by tests.
func (m *PasetoV4Maker) VerifyWSTicket(tok string) (*WSTicketPayload, error) {
	parser := p.NewParser()
	parser.AddRule(p.IssuedBy(m.keys.Issuer))
	parser.AddRule(p.ForAudience(WSTicketAudience))
	pt, err := parser.ParseV4Public(m.keys.PublicKey, tok, nil)
	if err != nil {
		return nil, ErrInvalidTokenV4
	}

	if tokenType, _ := pt.GetString("token_type"); tokenType != WSTicketType {
		return nil, ErrInvalidTokenV4
	}

	var out WSTicketPayload
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
	if out.UserID, err = strconv.ParseInt(userIDStr, 10, 64); err != nil {
		return nil, ErrInvalidTokenV4
	}
	if out.Doc, err = pt.GetString("doc"); err != nil || out.Doc == "" {
		return nil, ErrInvalidTokenV4
	}
	out.Username, _ = pt.GetString("username")
	out.IssuedAt, _ = pt.GetIssuedAt()
	out.ExpiredAt, _ = pt.GetExpiration()

	if time.Now().After(out.ExpiredAt) {
		return nil, ErrExpiredTokenV4
	}
	return &out, nil
}
