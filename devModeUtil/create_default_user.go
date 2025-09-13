package devModeUtil

import (
	"context"
	"log"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/util"
)

// CreateDefaultAdminUser creates a default admin user with known credentials
// for development and testing purposes. This function is designed exclusively
// for development environments.
//
// # WARNING: DEVELOPMENT ONLY
//
// This creates an admin user with the weak password "123456". This is NOT
// suitable for production use and represents a significant security vulnerability
// if enabled in production builds.
//
// # User Credentials
//
//   - Username: admin
//   - Email: admin@golive-cms.local
//   - Password: 123456 (plaintext, hashed using util.HashPassword)
//   - Role: admin (full system permissions)
//   - Full Name: Default Administrator
//
// # Idempotency
//
// Checks if a user with username "admin" already exists before creating.
// If found, logs a message and returns without creating a duplicate user.
// This makes the function safe to call multiple times.
//
// # Security Recommendations
//
//   - Change the default password immediately after first login
//   - Disable this function in production builds
//   - Consider environment-based password injection for CI/testing
//   - Use strong passwords for any production admin accounts
//
// # Error Handling
//
// Logs errors for password hashing failures and user creation failures,
// but does not panic or halt application startup. This allows the application
// to continue running even if user creation fails.
//
// # Example Usage
//
//	// In development initialization
//	store := db.NewStore(dbConnection)
//	devModeUtil.CreateDefaultAdminUser(store)
//
//	// First login credentials:
//	// Username: admin
//	// Password: 123456
//
// # Customization Options
//
// For environments requiring different admin credentials, consider creating
// a variant that reads from environment variables:
//
//	// Example customization (not implemented):
//	adminUser := os.Getenv("DEV_ADMIN_USER")     // default: admin
//	adminPass := os.Getenv("DEV_ADMIN_PASS")     // default: 123456
//	adminEmail := os.Getenv("DEV_ADMIN_EMAIL")   // default: admin@golive-cms.local
//
// This allows CI systems and development teams to customize admin credentials
// without modifying source code.
func CreateDefaultAdminUser(store db.Store) {
	log.Println("🔧 Checking for default admin user...")
	existingUser, err := store.GetUserByUsername(context.TODO(), "admin")
	if err == nil && existingUser.Username == "admin" {
		log.Println("ℹ️  Default admin user already exists, skipping creation")
		return
	}

	hashedPassword, err := util.HashPassword("123456")
	if err != nil {
		log.Printf("❌ Failed to hash admin password: %v", err)
		return
	}

	adminUser := db.CreateUserParams{
		Username:       "admin",
		Email:          "admin@golive-cms.local",
		FullName:       "Default Administrator",
		HashedPassword: hashedPassword,
		Role:           "admin",
	}
	createdUser, err := store.CreateUser(context.TODO(), adminUser)
	if err != nil {
		log.Printf("❌ Failed to create default admin user: %v", err)
		return
	}

	log.Printf("✅ Default admin user created successfully:")
	log.Printf("    Email: %s", createdUser.Email)
	log.Printf("    Username: %s", createdUser.Username)
	log.Printf("    Password: 123456")
	log.Printf("    Role: %s", createdUser.Role)
	log.Printf("    Note: This is a development-only user, change password in production!")
}
