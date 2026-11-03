package token

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
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
			return fmt.Errorf("previous public key %s: %w", kidForError(kid), err)
		}
		prev.public[kid] = pub
	}
	for kid, hex := range local {
		if err := checkPreviousKID(kid, m.keys.RefreshKID, "refresh"); err != nil {
			return err
		}
		lk, err := p.V4SymmetricKeyFromHex(hex)
		if err != nil {
			return fmt.Errorf("previous local key %s: %w", kidForError(kid), err)
		}
		prev.local[kid] = lk
	}
	m.previous = prev
	return nil
}

// kidForError quotes kid for an error message, unless it looks like key
// material: an entry written the wrong way round (<hex>=<kid>) puts the key
// where the KID goes, and startup errors are logged.
func kidForError(kid string) string {
	if len(kid) >= 32 && strings.Trim(strings.ToLower(kid), "0123456789abcdef") == "" {
		return "(a KID that looks like a hex key: entries are <kid>=<hex>)"
	}
	return strconv.Quote(kid)
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

// footerParser only reads footers (UnsafeParseFooter checks no rules), so one
// shared parser serves every verification.
var footerParser = p.NewParser()

// footerKID returns the "kid" of tok's footer, unverified (see above).
func footerKID(protocol p.Protocol, tok string) (string, bool) {
	raw, err := footerParser.UnsafeParseFooter(protocol, tok)
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
	var previous map[string]p.V4AsymmetricPublicKey
	if m.inGraceWindow() {
		previous = m.previous.public
	}
	return keyForKID(p.V4Public, tok, m.keys.AccessKID, m.keys.PublicKey, previous)
}

// localKeyFor is publicKeyFor for v4.local refresh tokens.
func (m *PasetoV4Maker) localKeyFor(tok string) (p.V4SymmetricKey, bool) {
	var previous map[string]p.V4SymmetricKey
	if m.inGraceWindow() {
		previous = m.previous.local
	}
	return keyForKID(p.V4Local, tok, m.keys.RefreshKID, m.keys.LocalKey, previous)
}

// keyForKID picks the key tok's footer KID names: current for currentKID,
// else the entry in previous (nil outside the grace window).
func keyForKID[K any](protocol p.Protocol, tok, currentKID string, current K, previous map[string]K) (K, bool) {
	kid, ok := footerKID(protocol, tok)
	if !ok {
		var none K
		return none, false
	}
	if kid == currentKID {
		return current, true
	}
	key, ok := previous[kid]
	return key, ok
}
