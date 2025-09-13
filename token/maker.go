// Package token provides secure token generation and validation for Go Live CMS.
//
// This package implements PASETO (Platform-Agnostic SEcurity TOkens) for secure
// authentication and authorization. It supports both PASETO v2 (legacy) and v4
// implementations, with v4 being the recommended approach for new applications.
//
// Which should I use?
//   - Use PasetoV4Maker unless you're maintaining legacy v2 tokens
//   - Access tokens = v4.public (verify with public key across services)
//   - Refresh tokens = v4.local (private to auth service, stored/rotated via cookies)
//
// Key Features:
//   - PASETO v4 with asymmetric (v4.public) and symmetric (v4.local) tokens
//   - Token payload with user information and expiration
//   - Configurable token types (access/refresh)
//   - Built-in token validation and expiration checking
//
// Security Notes:
//   - PASETO v4 uses Ed25519 for asymmetric operations and XChaCha20-Poly1305 for symmetric
//   - All tokens include cryptographic authentication (no need for separate HMAC)
//   - Token IDs use UUID v4 for uniqueness and future blacklisting support
//
// Threat Model Protection:
//   - Token replay → short access TTL + refresh rotation + JTI blacklist on reuse
//   - Key rotation → KID in footer + multiple active keys in verifier
//   - Logout / session kill → store refresh hash + JTI blacklist
//
// Interoperability:
//
//	Uses aidanwoods.dev/go-paseto library. Tokens are PASETO-spec compliant;
//	other services in other languages can verify v4.public with the same public key.
//
// Testing Guidance:
//
//	Use a fixed timeNow() injectable for deterministic tests. Consider a test
//	helper that constructs a maker with known test keys.
//
// Example Usage:
//
//	// Create a PASETO v4 maker
//	maker, err := NewPasetoV4Maker(privateKeyHex, publicKeyHex, localKeyHex,
//	                               "issuer", "audience", "access-kid", "refresh-kid")
//	if err != nil {
//	    log.Fatal(err)
//	}
//
//	// Create an access token
//	token, err := maker.CreateToken(userID, username, 15*time.Minute)
//	if err != nil {
//	    log.Fatal(err)
//	}
//
//	// Verify and extract payload
//	payload, err := maker.VerifyToken(token)
//	if err != nil {
//	    log.Printf("Invalid token: %v", err)
//	    return
//	}
package token

import (
	"errors"
	"time"
)

// Maker defines the interface for token creation and verification.
//
// This interface is the stable surface for the auth subsystem; concrete
// implementations (v2/v4) are behind it.
//
// Implementations should support both access and refresh tokens with different
// expiration durations. The interface is designed to be agnostic to the underlying
// token technology (PASETO, JWT, etc.) while providing consistent behavior.
//
// Token Types & Guarantees:
//   - CreateToken → issues access tokens only
//   - CreateRefreshToken → issues refresh tokens only
//   - VerifyToken → validates access tokens only; for refresh verification see
//     dedicated methods in v4 (ParseRefresh)
//
// Error Consistency:
//
//	Implementations must map their internal errors to ErrInvalidToken and
//	ErrExpiredToken where possible to keep callers implementation-agnostic.
//	Additional wrapped errors may be returned for detailed diagnostics.
//
// Clock Skew Handling:
//
//	Callers should allow small clock skew; implementations may set NBF
//	slightly in the past to handle clock differences between services.
//
// Token Lifetimes:
//   - Access tokens: Short-lived (typically 15-60 minutes) for API authentication
//   - Refresh tokens: Long-lived (typically 7-30 days) for obtaining new access tokens
//
// Security Considerations:
//   - Always validate tokens before trusting their contents
//   - Use appropriate expiration times for different token types
//   - Store refresh tokens securely (httpOnly cookies recommended)
//   - Consider implementing token blacklisting for enhanced security
type Maker interface {
	// CreateToken generates an access token for the specified user.
	//
	// Parameters:
	//   - userID: The unique identifier for the user
	//   - username: The username (for debugging/logging purposes)
	//   - duration: How long the token should remain valid
	//
	// Returns:
	//   - string: The encoded token ready for transmission
	//   - error: Any error that occurred during token creation
	//
	// Example:
	//   token, err := maker.CreateToken(123, "john_doe", 15*time.Minute)
	CreateToken(userID int64, username string, duration time.Duration) (string, error)

	// CreateRefreshToken generates a refresh token for the specified user.
	//
	// Refresh tokens are typically longer-lived than access tokens and are used
	// to obtain new access tokens without requiring re-authentication.
	//
	// Parameters:
	//   - userID: The unique identifier for the user
	//   - username: The username (for debugging/logging purposes)
	//   - duration: How long the refresh token should remain valid
	//
	// Returns:
	//   - string: The encoded refresh token
	//   - error: Any error that occurred during token creation
	//
	// Example:
	//   refreshToken, err := maker.CreateRefreshToken(123, "john_doe", 720*time.Hour)
	CreateRefreshToken(userID int64, username string, duration time.Duration) (string, error)

	// VerifyToken validates an access token and extracts its payload.
	//
	// This method verifies access tokens only. It rejects refresh tokens and any
	// token whose token_type claim is not "access". For refresh token verification,
	// see implementation-specific methods like ParseRefresh in v4.
	//
	// The method performs cryptographic verification of the token's authenticity
	// and checks for expiration. It returns the decoded payload if valid.
	//
	// Parameters:
	//   - token: The encoded access token string to verify
	//
	// Returns:
	//   - *Payload: The decoded token payload containing user info and metadata
	//   - error: ErrInvalidToken, ErrExpiredToken, or other verification errors
	//
	// Example:
	//   payload, err := maker.VerifyToken(accessTokenString)
	//   if err != nil {
	//       if errors.Is(err, ErrExpiredToken) {
	//           // Handle expired token - request refresh
	//       } else {
	//           // Handle invalid token - require re-authentication
	//       }
	//       return
	//   }
	//   userID := payload.UserID
	VerifyToken(token string) (*Payload, error)
}

// Example demonstrates basic token creation and verification workflow.
func ExampleMaker() {
	// This is a conceptual example - use NewPasetoV4Maker in practice
	var maker Maker

	// Create an access token
	token, err := maker.CreateToken(123, "john_doe", 15*time.Minute)
	if err != nil {
		// Handle error
		return
	}

	// Verify the token
	payload, err := maker.VerifyToken(token)
	if err != nil {
		// Handle verification error
		return
	}

	// Use the payload
	_ = payload.UserID // 123
}

// ExampleMaker_CreateToken demonstrates access token creation.
func ExampleMaker_CreateToken() {
	var maker Maker

	userID := int64(123)
	username := "john_doe"
	duration := 15 * time.Minute

	token, err := maker.CreateToken(userID, username, duration)
	if err != nil {
		// Handle token creation error
		return
	}

	// Token is ready for use in Authorization headers
	_ = "Bearer " + token
}

// ExampleMaker_CreateRefreshToken demonstrates refresh token creation.
func ExampleMaker_CreateRefreshToken() {
	var maker Maker

	userID := int64(123)
	username := "john_doe"
	duration := 720 * time.Hour // 30 days

	refreshToken, err := maker.CreateRefreshToken(userID, username, duration)
	if err != nil {
		// Handle token creation error
		return
	}

	// Store refresh token in httpOnly cookie
	_ = refreshToken
}

// ExampleMaker_VerifyToken demonstrates token verification with error handling.
func ExampleMaker_VerifyToken() {
	var maker Maker
	var tokenString string

	payload, err := maker.VerifyToken(tokenString)
	if err != nil {
		// Check for specific error types
		if errors.Is(err, ErrExpiredToken) {
			// Token expired - client should refresh
			return
		}
		if errors.Is(err, ErrInvalidToken) {
			// Invalid token - client should re-authenticate
			return
		}
		// Other error
		return
	}

	// Token is valid, use payload
	userID := payload.UserID
	username := payload.Username
	_, _ = userID, username
}

// See also Examples:
//   - ExampleMaker: Basic token workflow
//   - ExampleMaker_CreateToken: Access token creation
//   - ExampleMaker_CreateRefreshToken: Refresh token creation
//   - ExampleMaker_VerifyToken: Token verification with error handling
//   - ExampleNewPasetoMaker: PASETO v2 maker (legacy)
//   - ExamplePasetoV4Maker_CreateToken: PASETO v4 access tokens
//   - ExamplePasetoV4Maker_CreateRefreshToken: PASETO v4 refresh tokens
//   - ExamplePasetoV4Maker_VerifyToken: PASETO v4 verification
//   - ExamplePasetoV4Maker_ParseRefresh: PASETO v4 refresh parsing
