package token

import (
	"errors"
	"time"

	p "aidanwoods.dev/go-paseto"
)

// Key rotation (#139). See docs/operations/key-rotation.md for the procedure.
//
// New tokens are always signed/encrypted with the current keys. During a
// rotation the retired public key (access tokens) and/or local key (refresh
// tokens) can be registered with SetPreviousKeys: VerifyToken and
// ParseRefresh fall back to them, until the given time, for tokens the
// current keys reject. After that the previous keys are ignored, so a
// forgotten setting can't keep a retired key alive.
//
// Collab tickets (VerifyWSTicket) never fall back: they live 30 seconds.

// SetPreviousKeys registers the keys being rotated out. Either hex string may
// be empty (that key wasn't rotated); both empty clears any previous keys.
// until must be set when a key is given.
func (m *PasetoV4Maker) SetPreviousKeys(publicHex, localHex string, until time.Time) error {
	if publicHex == "" && localHex == "" {
		m.previous = nil
		return nil
	}
	if until.IsZero() {
		return errors.New("previous PASETO keys need an end of grace window")
	}

	prev := &previousKeys{until: until}
	if publicHex != "" {
		pub, err := p.NewV4AsymmetricPublicKeyFromHex(publicHex)
		if err != nil {
			return err
		}
		prev.publicKey = &pub
	}
	if localHex != "" {
		lk, err := p.V4SymmetricKeyFromHex(localHex)
		if err != nil {
			return err
		}
		prev.localKey = &lk
	}
	m.previous = prev
	return nil
}

// inGraceWindow reports whether previous keys are set and still accepted.
func (m *PasetoV4Maker) inGraceWindow() bool {
	return m.previous != nil && time.Now().Before(m.previous.until)
}
