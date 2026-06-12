package token

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	p "aidanwoods.dev/go-paseto"
	"github.com/google/uuid"
)

// V4Keys holds all cryptographic keys and metadata for PASETO v4 operations.
//
// This structure contains both asymmetric and symmetric keys to support
// different token types and use cases:
//   - Asymmetric keys (Ed25519): For v4.public tokens that can be verified by multiple services
//   - Symmetric key (XChaCha20-Poly1305): For v4.local tokens with faster operations
//   - KIDs (Key IDs): For key rotation and identifying which key to use for verification
//   - Claims: Standard JWT-like claims for token metadata
//
// Key Rotation:
//
//	Access and refresh tokens can use different keys (identified by KID) to enable
//	independent rotation schedules and revocation capabilities.
type V4Keys struct {
	PrivateKey p.V4AsymmetricSecretKey // Ed25519 private key for signing v4.public tokens
	PublicKey  p.V4AsymmetricPublicKey // Ed25519 public key for verifying v4.public tokens
	LocalKey   p.V4SymmetricKey        // XChaCha20-Poly1305 key for v4.local tokens
	AccessKID  string                  // Key ID for access tokens (supports rotation)
	RefreshKID string                  // Key ID for refresh tokens (supports rotation)
	Issuer     string                  // Token issuer claim (typically service name)
	Audience   string                  // Intended audience claim (typically client/app name)
}

// PasetoV4Maker implements the Maker interface using PASETO v4 tokens.
//
// Design Choice: GoLive issues v4.public for access and v4.local for refresh.
//
// PASETO v4 provides several advantages over older token systems:
//   - No algorithm confusion attacks (algorithms are version-specific)
//   - Authenticated encryption built-in (no separate HMAC needed)
//   - Ed25519 signatures for public tokens (compact and fast)
//   - XChaCha20-Poly1305 for local tokens (excellent performance)
//   - Structured footer support for key rotation metadata
//
// Token Types Generated:
//   - Access tokens: v4.public (can be verified by multiple services)
//   - Refresh tokens: v4.local (only this service can decrypt/verify)
//
// This design allows access tokens to be verified by multiple microservices
// while keeping refresh tokens private to the authentication service.
type PasetoV4Maker struct {
	keys V4Keys
}

// NewPasetoV4Maker creates a new PASETO v4 token maker with the provided keys and claims.
//
// NewPasetoV4Maker returns an error if any hex key is invalid or wrong length,
// providing early validation to prevent runtime token failures.
//
// This constructor validates all provided key material and initializes the maker
// with both asymmetric and symmetric capabilities.
//
// Key Requirements:
//   - privHex: Ed25519 private key as 128-character hex string (64 bytes)
//   - pubHex: Ed25519 public key as 64-character hex string (32 bytes)
//   - localHex: XChaCha20-Poly1305 key as 64-character hex string (32 bytes)
//
// Footer JSON Schema:
//
//	{"kid": "<string>", "ver": "v4.public"|"v4.local"}
//	Verifiers should not trust KID alone; they still perform cryptographic
//	verification and use KID only to select keys.
//
// Claims Table (both access/refresh):
//
//	iss (string), aud (string), sub (username string), jti (uuid),
//	iat, nbf, exp, custom: user_id (string), username (string),
//	token_type ("access"|"refresh")
//
// Parameters:
//   - privHex: Hex-encoded Ed25519 private key for signing
//   - pubHex: Hex-encoded Ed25519 public key for verification
//   - localHex: Hex-encoded symmetric key for local tokens
//   - iss: Issuer claim (e.g., "auth.myapp.com")
//   - aud: Audience claim (e.g., "api.myapp.com")
//   - accessKID: Key identifier for access tokens
//   - refreshKID: Key identifier for refresh tokens
//
// Returns:
//   - *PasetoV4Maker: Configured token maker ready for use
//   - error: Key parsing errors or invalid key material
//
// Example:
//
//	maker, err := NewPasetoV4Maker(
//	    "64-byte-private-key-as-128-hex-chars",
//	    "32-byte-public-key-as-64-hex-chars",
//	    "32-byte-local-key-as-64-hex-chars",
//	    "auth.myapp.com", "api.myapp.com",
//	    "v4.pub.2025-09", "v4.loc.2025-09")
//	if err != nil {
//	    log.Fatal("Failed to create token maker:", err)
//	}
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

// CreateToken generates a PASETO v4.public access token.
//
// Access tokens use asymmetric cryptography (Ed25519) so they can be verified
// by multiple services without sharing secret keys. The token includes standard
// claims (iss, aud, sub, exp, etc.) plus custom claims for user identification.
//
// Token Features:
//   - v4.public format for multi-service verification
//   - Ed25519 signature for authenticity
//   - Footer contains KID for key rotation support
//   - NBF (not before) set 15 seconds in the past to handle clock skew
//   - Custom claims: user_id, username, token_type
//
// Clock Skew Rationale:
//
//	NBF = now - 15s handles clock differences between services. Parsers must
//	still respect NBF but this prevents immediate rejection due to minor skew.
//
// The generated token can be verified by any service with access to the
// corresponding public key, making it ideal for microservice architectures.
//
// Implements the Maker interface.
func (m *PasetoV4Maker) CreateToken(userID int64, username string, dur time.Duration) (string, error) {
	return m.CreateTokenWithRole(userID, username, "", dur)
}

// CreateTokenWithRole generates a v4.public access token carrying an
// INFORMATIONAL role claim. Not part of the Maker interface — only the login
// flow (which has the fresh DB user in scope) calls it; renewal sticks with
// CreateToken and omits the claim.
//
// The claim is for clients and observability only: authorization always
// re-reads the role from the database (see api requireRole), so a stale claim
// can never grant privileges. An empty role omits the claim entirely.
func (m *PasetoV4Maker) CreateTokenWithRole(userID int64, username, role string, dur time.Duration) (string, error) {
	t := p.NewToken()
	now := time.Now()
	t.SetIssuedAt(now)
	t.SetNotBefore(now.Add(-15 * time.Second))
	t.SetExpiration(now.Add(dur))
	t.SetIssuer(m.keys.Issuer)
	t.SetAudience(m.keys.Audience)
	t.SetSubject(username)
	t.SetJti(uuid.NewString())
	_ = t.Set("user_id", strconv.FormatInt(userID, 10))
	_ = t.Set("username", username)
	_ = t.Set("token_type", "access")
	if role != "" {
		_ = t.Set("role", role)
	}

	footer, _ := json.Marshal(map[string]string{"kid": m.keys.AccessKID, "ver": "v4.public"})
	t.SetFooter(footer)

	return t.V4Sign(m.keys.PrivateKey, nil), nil
}

// CreateRefreshToken generates a PASETO v4.local refresh token.
//
// Refresh tokens use symmetric cryptography (XChaCha20-Poly1305) for better
// performance and to keep them private to the authentication service. Only
// services with the symmetric key can decrypt and verify these tokens.
//
// Token Features:
//   - v4.local format for symmetric encryption/authentication
//   - XChaCha20-Poly1305 for authenticated encryption
//   - Footer contains KID for key rotation support
//   - Longer expiration than access tokens
//   - Same custom claims as access tokens
//
// This design prevents refresh tokens from being used by other services
// while allowing access tokens to be distributed more freely.
//
// Implements the Maker interface.
func (m *PasetoV4Maker) CreateRefreshToken(userID int64, username string, dur time.Duration) (string, error) {
	t := p.NewToken()
	now := time.Now()
	t.SetIssuedAt(now)
	t.SetNotBefore(now.Add(-15 * time.Second))
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

// Token verification errors specific to PASETO v4 implementation.
//
// Error Mapping: Higher-level code should map these to the canonical
// ErrInvalidToken/ErrExpiredToken when exposed to callers to keep API uniform.
var (
	// ErrInvalidTokenV4 indicates the token is malformed or verification failed.
	ErrInvalidTokenV4 = errors.New("token is invalid")

	// ErrExpiredTokenV4 indicates the token has passed its expiration time.
	ErrExpiredTokenV4 = errors.New("token has expired")
)

// VerifyToken validates and parses a PASETO v4.public access token.
//
// VerifyToken Contract: This method verifies v4.public access tokens only.
// It rejects v4.local tokens and any token whose token_type claim is not "access".
// For refresh tokens, use ParseRefresh.
//
// This method performs comprehensive token validation including:
//   - Cryptographic signature verification using Ed25519
//   - Issuer and audience claim validation
//   - Expiration time checking
//   - Token type validation (must be "access")
//   - Payload extraction and parsing
//
// The method expects v4.public tokens and will reject v4.local tokens.
// For refresh token verification, use ParseRefresh instead.
//
// Security Features:
//   - Constant-time signature verification
//   - Claims validation prevents token misuse
//   - Expiration checking prevents replay attacks
//
// Implements the Maker interface.
//
// Returns:
//   - *Payload: Decoded token payload if valid
//   - error: ErrInvalidTokenV4, ErrExpiredTokenV4, or parsing errors
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
	// Informational only; absent on renewal-issued and pre-#187 tokens.
	out.Role, _ = pt.GetString("role")

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

// ParseRefresh decrypts and validates a PASETO v4.local refresh token.
//
// Intended for refresh workflows only. For access tokens, use VerifyToken.
//
// This method handles refresh token verification separately from access tokens
// because they use different cryptographic primitives (symmetric vs asymmetric).
// It validates issuer/audience claims and returns the raw token for further processing.
//
// ParseRefresh returns a raw *p.Token so callers can inspect claims and JTI
// for rotation / reuse detection.
//
// Unlike VerifyToken, this method returns the raw PASETO token object rather
// than a parsed Payload, allowing callers to extract claims as needed for
// refresh token workflows.
//
// Parameters:
//   - tok: The PASETO v4.local refresh token string
//
// Returns:
//   - *p.Token: Raw PASETO token object with claims
//   - error: Decryption or validation errors
//
// Example:
//
//	token, err := maker.ParseRefresh(refreshTokenString)
//	if err != nil {
//	    return errors.New("invalid refresh token")
//	}
//	userID, _ := token.GetString("user_id")
func (m *PasetoV4Maker) ParseRefresh(tok string) (*p.Token, error) {
	parser := p.NewParser()
	parser.AddRule(p.IssuedBy(m.keys.Issuer))
	parser.AddRule(p.ForAudience(m.keys.Audience))
	return parser.ParseV4Local(m.keys.LocalKey, tok, nil)
}

// HashRefresh creates a SHA-256 hash of a refresh token for secure storage.
//
// Store the hash instead of the plaintext token. Consider salting per session
// for unlinkability: combine with per-session salt if you want unlinkability
// across sessions; store hash + salt.
//
// This utility function is useful for storing refresh token hashes in a database
// instead of storing the tokens in plaintext. The hash can be used for:
//   - Token blacklisting after logout
//   - Refresh token rotation tracking
//   - Audit logging without exposing actual tokens
//
// Parameters:
//   - token: The refresh token string to hash
//
// Returns:
//   - []byte: SHA-256 hash of the token (32 bytes)
//
// Example:
//
//	hash := HashRefresh(refreshToken)
//	// Store hash in database for blacklisting
//	db.StoreTokenHash(userID, hash, expirationTime)
func HashRefresh(token string) []byte {
	h := sha256.Sum256([]byte(token))
	return h[:]
}

// ExamplePasetoV4Maker_CreateToken demonstrates v4.public access token creation.
func ExamplePasetoV4Maker_CreateToken() {
	// Create maker with test keys (shortened for example)
	maker, _ := NewPasetoV4Maker(
		"test-private-key-hex", "test-public-key-hex", "test-local-key-hex",
		"test.issuer", "test.audience", "access-kid", "refresh-kid")

	// Create access token
	token, err := maker.CreateToken(123, "john_doe", 15*time.Minute)
	if err != nil {
		// Handle error
		return
	}

	// Token is v4.public format
	_ = token
}

// ExamplePasetoV4Maker_CreateRefreshToken demonstrates v4.local refresh token creation.
func ExamplePasetoV4Maker_CreateRefreshToken() {
	maker, _ := NewPasetoV4Maker(
		"test-private-key-hex", "test-public-key-hex", "test-local-key-hex",
		"test.issuer", "test.audience", "access-kid", "refresh-kid")

	// Create refresh token (longer duration)
	refreshToken, err := maker.CreateRefreshToken(123, "john_doe", 720*time.Hour)
	if err != nil {
		// Handle error
		return
	}

	// Token is v4.local format
	_ = refreshToken
}

// ExamplePasetoV4Maker_VerifyToken demonstrates access token verification.
func ExamplePasetoV4Maker_VerifyToken() {
	maker, _ := NewPasetoV4Maker(
		"test-private-key-hex", "test-public-key-hex", "test-local-key-hex",
		"test.issuer", "test.audience", "access-kid", "refresh-kid")

	var accessToken string

	// Verify access token
	payload, err := maker.VerifyToken(accessToken)
	if err != nil {
		// Handle verification error
		return
	}

	// Use payload data
	userID := payload.UserID
	_ = userID
}

// ExamplePasetoV4Maker_ParseRefresh demonstrates refresh token parsing.
func ExamplePasetoV4Maker_ParseRefresh() {
	maker, _ := NewPasetoV4Maker(
		"test-private-key-hex", "test-public-key-hex", "test-local-key-hex",
		"test.issuer", "test.audience", "access-kid", "refresh-kid")

	var refreshToken string

	// Parse refresh token
	token, err := maker.ParseRefresh(refreshToken)
	if err != nil {
		// Handle parsing error
		return
	}

	// Extract claims from raw token
	userID, _ := token.GetString("user_id")
	_ = userID
}

// GetPublicKeyPEM returns the Ed25519 public key in PEM format for use by other services.
//
// This method exports the public key in standard PEM encoding that can be used
// by external services (like the WebSocket server) to verify PASETO v4.public tokens.
//
// Example usage:
//
//	maker := /* initialize PasetoV4Maker */
//	pemKey, err := maker.GetPublicKeyPEM()
//	if err != nil {
//	    log.Fatal("Failed to export public key:", err)
//	}
//	fmt.Println("Public key for WebSocket server:")
//	fmt.Println(pemKey)
//
// The returned PEM can be used in Node.js with:
//
//	const publicKey = createPublicKey(pemString);
func (m *PasetoV4Maker) GetPublicKeyPEM() (string, error) {
	// Get the raw Ed25519 public key bytes (32 bytes)
	keyBytes := m.keys.PublicKey.ExportBytes()

	// Ed25519 public key in SubjectPublicKeyInfo DER format
	// This creates a proper ASN.1 DER structure for Ed25519 keys
	derHeader := []byte{
		0x30, 0x2a, // SEQUENCE (42 bytes)
		0x30, 0x05, // SEQUENCE (5 bytes) - Algorithm
		0x06, 0x03, 0x2b, 0x65, 0x70, // OID for Ed25519: 1.3.101.112
		0x03, 0x21, 0x00, // BIT STRING (33 bytes), no unused bits
	}

	derKey := append(derHeader, keyBytes...)

	// Convert to PEM format
	pemData := base64.StdEncoding.EncodeToString(derKey)

	// Format as PEM with proper line breaks (64 chars per line)
	var pemLines []string
	for i := 0; i < len(pemData); i += 64 {
		end := i + 64
		if end > len(pemData) {
			end = len(pemData)
		}
		pemLines = append(pemLines, pemData[i:end])
	}

	pem := "-----BEGIN PUBLIC KEY-----\n" +
		strings.Join(pemLines, "\n") +
		"\n-----END PUBLIC KEY-----"

	return pem, nil
}
