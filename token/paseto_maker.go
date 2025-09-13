package token

import (
	"fmt"
	"time"

	"github.com/aead/chacha20poly1305"
	"github.com/o1egl/paseto"
)

// PasetoMaker implements the Maker interface using PASETO v2 tokens.
//
// Deprecated: Use PasetoV4Maker instead. PASETO v2 is maintained for
// backwards compatibility but new implementations should prefer v4.
//
// Migration: See PasetoV4Maker for the recommended approach. Migration typically
// involves generating new v4 keys and updating configuration to use v4.public
// for access tokens and v4.local for refresh tokens.
//
// PASETO v2 uses ChaCha20-Poly1305 for authenticated encryption, providing
// good security properties but lacking some of the improvements in v4:
//   - No key rotation support (no KID in footer → deployment friction)
//   - Only symmetric tokens (no public/private key options)
//   - Less efficient for multi-service verification
//
// Security Caveat:
// v2.local requires sharing the same symmetric key across all services that
// verify tokens; prefer v4.public for multi-service verification.
//
// Footer/KID Limitations:
// Without KID metadata, key rotation requires coordinated deployment across
// all services, making it difficult to implement zero-downtime key updates.
//
// This implementation generates v2.local tokens for both access and refresh
// tokens, requiring all services to share the same symmetric key.
type PasetoMaker struct {
	paseto       *paseto.V2 // PASETO v2 implementation
	symmetricKey []byte     // ChaCha20-Poly1305 symmetric key
}

// NewPasetoMaker creates a new PASETO v2 token maker with the provided symmetric key.
//
// Deprecated: Use NewPasetoV4Maker for new applications.
//
// The symmetric key is used for both encryption and decryption of all tokens.
// All services that need to verify tokens must have access to this key.
//
// Key Requirements:
//   - Must be exactly 32 bytes (256 bits) for ChaCha20-Poly1305
//   - Should be cryptographically random
//   - Must be securely distributed to all services that verify tokens
//   - Hex example: 64 hex characters = 32 bytes
//     (e.g., "abcd1234...") if converting from hex elsewhere
//
// Parameters:
//   - symmetricKey: A 32-byte key as a string (exactly 32 bytes)
//
// Returns:
//   - Maker: Token maker implementing the Maker interface
//   - error: Key validation errors
//
// Example:
//
//	key := "your-32-byte-secret-key-here!!" // Exactly 32 bytes
//	maker, err := NewPasetoMaker(key)
//	if err != nil {
//	    log.Fatal("Invalid key:", err)
//	}
func NewPasetoMaker(symmetricKey string) (Maker, error) {
	if len(symmetricKey) != chacha20poly1305.KeySize {
		return nil, fmt.Errorf("invalid symmetric key size: must be %d bytes", chacha20poly1305.KeySize)
	}
	maker := &PasetoMaker{
		paseto:       paseto.NewV2(),
		symmetricKey: []byte(symmetricKey),
	}
	return maker, nil
}

// CreateToken generates a PASETO v2.local access token.
// Implements the Maker interface for backwards compatibility.
func (maker *PasetoMaker) CreateToken(userID int64, username string, duration time.Duration) (string, error) {
	payload, err := NewPayload(userID, username, duration, "access")
	if err != nil {
		return "", err
	}
	return maker.paseto.Encrypt(maker.symmetricKey, payload, nil)
}

// CreateRefreshToken generates a PASETO v2.local refresh token.
// Implements the Maker interface for backwards compatibility.
func (maker *PasetoMaker) CreateRefreshToken(userID int64, username string, duration time.Duration) (string, error) {
	payload, err := NewPayload(userID, username, duration, "refresh")
	if err != nil {
		return "", err
	}
	return maker.paseto.Encrypt(maker.symmetricKey, payload, nil)
}

// VerifyToken decrypts and validates a PASETO v2.local token.
// Implements the Maker interface for backwards compatibility.
func (maker *PasetoMaker) VerifyToken(token string) (*Payload, error) {
	payload := &Payload{}

	err := maker.paseto.Decrypt(token, maker.symmetricKey, payload, nil)
	if err != nil {
		return nil, ErrInvalidToken
	}

	err = payload.Valid()
	if err != nil {
		return nil, err
	}
	return payload, nil
}

// ExampleNewPasetoMaker demonstrates creating a PASETO v2 maker.
func ExampleNewPasetoMaker() {
	// Use exactly 32 bytes for the key
	key := "your-32-byte-secret-key-here!!" // Exactly 32 bytes

	maker, err := NewPasetoMaker(key)
	if err != nil {
		// Handle invalid key error
		return
	}

	// Maker is ready for token operations
	_ = maker
}

// ExamplePasetoMaker_CreateToken demonstrates v2.local token creation.
func ExamplePasetoMaker_CreateToken() {
	key := "your-32-byte-secret-key-here!!" // Exactly 32 bytes
	maker, _ := NewPasetoMaker(key)

	// Create an access token
	token, err := maker.CreateToken(123, "john_doe", 15*time.Minute)
	if err != nil {
		// Handle token creation error
		return
	}

	// Token is a v2.local PASETO token
	_ = token
}
