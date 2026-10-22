package devModeUtil

import (
	"context"
	"log"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/util"
)

// AdminAccount returns the credentials the seed gives the admin account:
// SEED_ADMIN_USER / SEED_ADMIN_PASS, each defaulting to DefaultAdminUsername /
// DefaultAdminPassword when empty.
func AdminAccount(config util.Config) SeededAccount {
	account := SeededAccount{Username: DefaultAdminUsername, Password: DefaultAdminPassword}
	if config.SeedAdminUsername != "" {
		account.Username = config.SeedAdminUsername
	}
	if config.SeedAdminPassword != "" {
		account.Password = config.SeedAdminPassword
	}
	return account
}

// CreateDefaultAdminUser creates the seed's admin user for development and
// testing purposes. This function is designed exclusively for development
// environments.
//
// # WARNING: DEVELOPMENT ONLY
//
// By default this creates admin with the weak password "123456". This is NOT
// suitable for production use and represents a significant security vulnerability
// if enabled in production builds.
//
// # User Credentials
//
//   - Username: account.Username (admin unless SEED_ADMIN_USER is set)
//   - Email: <username>@golive-cms.local
//   - Password: account.Password (123456 unless SEED_ADMIN_PASS is set)
//   - Role: admin (full system permissions)
//   - Full Name: Default Administrator
//
// # Idempotency
//
// Checks if a user with that username already exists before creating.
// If found, logs a message and returns without creating a duplicate user.
// This makes the function safe to call multiple times.
//
// # Security Recommendations
//
//   - Change the default password immediately after first login
//   - Runs on startup only with GIN_MODE=debug, and from cmd/seed. Outside
//     debug mode, startup refuses to run while this account still has the
//     default password (FindSeededAccountsWithSeededPasswords)
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
//	store := db.NewStore(dbConnection)
//	devModeUtil.CreateDefaultAdminUser(store, devModeUtil.AdminAccount(config))
func CreateDefaultAdminUser(store db.Store, account SeededAccount) {
	log.Println("🔧 Checking for default admin user...")
	existingUser, err := store.GetUserByUsername(context.TODO(), account.Username)
	if err == nil && existingUser.Username == account.Username {
		log.Println("ℹ️  Default admin user already exists, skipping creation")
		return
	}

	hashedPassword, err := util.HashPassword(account.Password)
	if err != nil {
		log.Printf("❌ Failed to hash admin password: %v", err)
		return
	}

	adminUser := db.CreateUserParams{
		Username:       account.Username,
		Email:          account.Username + "@golive-cms.local",
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
	if account.Password == DefaultAdminPassword {
		log.Printf("    Password: %s", DefaultAdminPassword)
	} else {
		log.Printf("    Password: (from SEED_ADMIN_PASS)")
	}
	log.Printf("    Role: %s", createdUser.Role)
	log.Printf("    Note: This is a development-only user, change password in production!")
}
