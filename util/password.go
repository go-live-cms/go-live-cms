package util

import (
	"fmt"

	"golang.org/x/crypto/bcrypt"
)

// HashPassword creates a bcrypt hash of the provided password.
//
// The function validates that the password length is between 6 and 72 characters.
// Note: bcrypt truncates to 72 *bytes*. Non-ASCII characters may exceed this
// when UTF-8 encoded. Consider validating utf8.RuneCountInString vs. byte length
// if you have specific UX requirements.
//
// Uses bcrypt.DefaultCost for security. For configurable cost, see HashPasswordWithCost.
//
// Parameters:
//   - password: The plaintext password to hash (must be 6-72 characters)
//
// Returns:
//   - string: The bcrypt hash of the password
//   - error: An error if the password is invalid or hashing fails
//
// Example:
//
//	hashedPwd, err := HashPassword("mySecurePassword123")
//	if err != nil {
//	    log.Fatal("Failed to hash password:", err)
//	}
func HashPassword(password string) (string, error) {
	if len(password) < 6 {
		return "", fmt.Errorf("password must be at least 6 characters long")
	}

	if len(password) > 72 {
		return "", fmt.Errorf("password must be at most 72 characters long")
	}

	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", fmt.Errorf("failed to hash password: %w", err)
	}
	return string(hashedPassword), nil
}

// HashPasswordWithCost creates a bcrypt hash with the specified cost.
//
// Higher cost values increase security but require more computation time.
// Recommended cost range is 10-14. Cost 12+ is suitable for production
// systems with sufficient hardware resources.
//
// Trade-offs:
//   - Cost 10: ~10ms per hash, minimum for production
//   - Cost 12: ~40ms per hash, good balance for most applications
//   - Cost 14: ~160ms per hash, high security for sensitive systems
//
// Parameters:
//   - password: The plaintext password to hash (must be 6-72 characters)
//   - cost: The bcrypt cost parameter (4-31, but 10-14 recommended)
//
// Returns:
//   - string: The bcrypt hash of the password
//   - error: An error if the password is invalid or hashing fails
//
// Example:
//
//	hashedPwd, err := HashPasswordWithCost("mySecurePassword123", 12)
//	if err != nil {
//	    log.Fatal("Failed to hash password:", err)
//	}
func HashPasswordWithCost(password string, cost int) (string, error) {
	if len(password) < 6 {
		return "", fmt.Errorf("password must be at least 6 characters long")
	}

	if len(password) > 72 {
		return "", fmt.Errorf("password must be at most 72 characters long")
	}

	if cost < bcrypt.MinCost || cost > bcrypt.MaxCost {
		return "", fmt.Errorf("bcrypt cost must be between %d and %d", bcrypt.MinCost, bcrypt.MaxCost)
	}

	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(password), cost)
	if err != nil {
		return "", fmt.Errorf("failed to hash password: %w", err)
	}
	return string(hashedPassword), nil
}

// CheckPassword verifies if a plaintext password matches a bcrypt hash.
//
// Uses bcrypt's constant-time comparison to mitigate timing attacks.
//
// Parameters:
//   - password: The plaintext password to verify
//   - hashedPassword: The bcrypt hash to compare against
//
// Returns:
//   - error: nil if the password matches, bcrypt.ErrMismatchedHashAndPassword if not,
//     or another error if comparison fails
//
// Example:
//
//	if err := CheckPassword(userInput, storedHash); err != nil {
//	    if errors.Is(err, bcrypt.ErrMismatchedHashAndPassword) {
//	        // invalid credentials
//	        return errors.New("authentication failed")
//	    } else {
//	        // hashing/compare error
//	        return fmt.Errorf("password verification error: %w", err)
//	    }
//	}
func CheckPassword(password, hashedPassword string) error {
	return bcrypt.CompareHashAndPassword([]byte(hashedPassword), []byte(password))
}

// CheckPasswordMatch is a convenience function that returns a boolean
// indicating whether a password matches its hash.
//
// This function wraps CheckPassword and returns true if the password matches,
// false otherwise. It's useful when you only need a simple boolean result
// rather than handling the specific error types.
//
// Parameters:
//   - password: The plaintext password to verify
//   - hashedPassword: The bcrypt hash to compare against
//
// Returns:
//   - bool: true if the password matches the hash, false otherwise
//
// Example:
//
//	if CheckPasswordMatch(userInput, storedHash) {
//	    // Password is correct, proceed with authentication
//	    loginUser(userID)
//	} else {
//	    // Password is incorrect
//	    return errors.New("invalid credentials")
//	}
func CheckPasswordMatch(password, hashedPassword string) bool {
	err := CheckPassword(password, hashedPassword)
	return err == nil
}

// Security Note: Application-Level Pepper
//
// Some high-security deployments use an application-level "pepper"
// (a secret key stored in a key management service) in addition to
// bcrypt's per-hash salts. The pepper is concatenated with the password
// before hashing and provides defense against database compromise.
//
// Example pattern:
//   pepperKey := loadFromKMS() // 32+ random bytes
//   passwordWithPepper := password + hex.EncodeToString(pepperKey)
//   hash := HashPassword(passwordWithPepper)
//
// This adds complexity but may be warranted for applications storing
// highly sensitive data or operating under strict compliance requirements.
