package main

import (
	"fmt"
	"log"

	"github.com/go-live-cms/go-live-cms/token"
	"github.com/go-live-cms/go-live-cms/util"
)

// exportPubKey is a utility to export the Ed25519 public key in PEM format
// for use by the WebSocket server's PASETO v4.public token verification.
//
// Usage:
//
//	go run cmd/export-pubkey/main.go
//
// This will read the configuration from app.env and output the public key
// in PEM format that can be copied to the WebSocket server's .env file.
func main() {
	// Load configuration from app.env
	config, err := util.LoadConfig(".")
	if err != nil {
		log.Fatal("Cannot load config:", err)
	}

	// Create PASETO v4 maker using the same keys as the main application
	maker, err := token.NewPasetoV4Maker(
		config.PasetoV4PrivateKeyHex, // Ed25519 private key
		config.PasetoV4PublicKeyHex,  // Ed25519 public key
		config.PasetoV4LocalKeyHex,   // XChaCha20-Poly1305 local key
		config.PasetoIssuer,
		config.PasetoAudience,
		config.PasetoAccessKID,
		config.PasetoRefreshKID,
	)
	if err != nil {
		log.Fatal("Cannot create PASETO v4 maker:", err)
	}

	// Export the public key in PEM format
	pemKey, err := maker.GetPublicKeyPEM()
	if err != nil {
		log.Fatal("Cannot export public key:", err)
	}

	fmt.Println("# Ed25519 Public Key for WebSocket Server")
	fmt.Println("# Copy this to your websocket/.env file as PASETO_V4_PUBLIC_PEM")
	fmt.Println()
	fmt.Printf("PASETO_V4_PUBLIC_PEM=\"%s\"\n", pemKey)
	fmt.Println()
	fmt.Println("# Also make sure these settings match your Go API:")
	fmt.Printf("PASETO_ISSUER=%s\n", config.PasetoIssuer)
	fmt.Printf("PASETO_AUDIENCE=%s-ws\n", config.PasetoAudience)
	fmt.Println()
	fmt.Println("# Example usage in websocket/.env:")
	fmt.Println("# HOST=0.0.0.0")
	fmt.Println("# PORT=1234")
	fmt.Printf("# PASETO_ISSUER=%s\n", config.PasetoIssuer)
	fmt.Printf("# PASETO_AUDIENCE=%s-ws\n", config.PasetoAudience)
}
