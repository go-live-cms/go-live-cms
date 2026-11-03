package token

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	p "aidanwoods.dev/go-paseto"
)

// Key rotation (#139, #158). See docs/operations/key-rotation.md for the procedure.
//
// New tokens are always signed/encrypted with the current keys, and their
// footer names the current KID. During a rotation the retired public keys
// (access tokens) and/or local keys (refresh tokens) are registered with
// SetPreviousKeys, each under the KID its tokens carry. VerifyToken and
// ParseRefresh pick the one key the token's footer KID names: the current
// KID selects the current key, a previous KID that key, until the grace
// window ends. A token whose KID names no usable key is rejected without
// trying any key. After the window the previous keys are ignored, so a
// forgotten setting can't keep a retired key alive.
//
// The footer is read before verification only to choose the key. PASETO
// authenticates the footer with the payload, so a token can't verify under a
// key its KID doesn't name.
//
// Collab tickets (VerifyWSTicket) never fall back: they live 30 seconds.

// SetPreviousKeys registers the keys being rotated out, as KID → hex key maps.
// Either map may be empty (that key wasn't rotated); both empty clears any
// previous keys. until must be set when a key is given. A previous KID must
// differ from the current KID of the same kind: the KID is what tells the
// keys apart.
func (m *PasetoV4Maker) SetPreviousKeys(public, local map[string]string, until time.Time) error {
	if len(public) == 0 && len(local) == 0 {
		m.previous = nil
		return nil
	}
	if until.IsZero() {
		return errors.New("previous PASETO keys need an end of grace window")
	}

	prev := &previousKeys{
		public: make(map[string]p.V4AsymmetricPublicKey, len(public)),
		local:  make(map[string]p.V4SymmetricKey, len(local)),
		until:  until,
	}
	for kid, hex := range public {
		if err := checkPreviousKID(kid, m.keys.AccessKID, "access"); err != nil {
			return err
		}
		pub, err := p.NewV4AsymmetricPublicKeyFromHex(hex)
		if err != nil {
			return fmt.Errorf("previous public key %q: %w", kid, err)
		}
		prev.public[kid] = pub
	}
	for kid, hex := range local {
		if err := checkPreviousKID(kid, m.keys.RefreshKID, "refresh"); err != nil {
			return err
		}
		lk, err := p.V4SymmetricKeyFromHex(hex)
		if err != nil {
			return fmt.Errorf("previous local key %q: %w", kid, err)
		}
		prev.local[kid] = lk
	}
	m.previous = prev
	return nil
}

func checkPreviousKID(kid, currentKID, kind string) error {
	if kid == "" {
		return fmt.Errorf("a previous %s key needs a KID", kind)
	}
	if kid == currentKID {
		return fmt.Errorf("previous %s key KID %q is the current %s KID: give the new key a new KID", kind, kid, kind)
	}
	return nil
}

// inGraceWindow reports whether previous keys are set and still accepted.
func (m *PasetoV4Maker) inGraceWindow() bool {
	return m.previous != nil && time.Now().Before(m.previous.until)
}

// footerKID returns the "kid" of tok's footer, unverified (see above).
func footerKID(protocol p.Protocol, tok string) (string, bool) {
	raw, err := p.NewParser().UnsafeParseFooter(protocol, tok)
	if err != nil {
		return "", false
	}
	var footer struct {
		KID string `json:"kid"`
	}
	if err := json.Unmarshal(raw, &footer); err != nil || footer.KID == "" {
		return "", false
	}
	return footer.KID, true
}

// publicKeyFor returns the key that must verify the v4.public access token
// tok, chosen by its footer KID, or false when no usable key has that KID.
func (m *PasetoV4Maker) publicKeyFor(tok string) (p.V4AsymmetricPublicKey, bool) {
	kid, ok := footerKID(p.V4Public, tok)
	if !ok {
		return p.V4AsymmetricPublicKey{}, false
	}
	if kid == m.keys.AccessKID {
		return m.keys.PublicKey, true
	}
	if m.inGraceWindow() {
		key, ok := m.previous.public[kid]
		return key, ok
	}
	return p.V4AsymmetricPublicKey{}, false
}

// localKeyFor is publicKeyFor for v4.local refresh tokens.
func (m *PasetoV4Maker) localKeyFor(tok string) (p.V4SymmetricKey, bool) {
	kid, ok := footerKID(p.V4Local, tok)
	if !ok {
		return p.V4SymmetricKey{}, false
	}
	if kid == m.keys.RefreshKID {
		return m.keys.LocalKey, true
	}
	if m.inGraceWindow() {
		key, ok := m.previous.local[kid]
		return key, ok
	}
	return p.V4SymmetricKey{}, false
}
