package devModeUtil

import (
	"context"
	"log"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/util"
)

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
