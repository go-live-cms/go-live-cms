// Package util provides configuration loading and utilities for Go Live CMS.
//
// Configuration is sourced from environment variables (via viper) and an optional
// app.env file. All exported fields are safe to reference across the codebase.
package util

import (
	"time"

	"github.com/spf13/viper"
)

// Config holds all application configuration for Go Live CMS.
//
// Values are populated from environment variables (see mapstructure tags) and
// optional app.env file. For durations, use time.ParseDuration formats (e.g. "15m", "24h").
//
// Environment variables (examples):
//
//	DB_DRIVER=postgres
//	DB_SOURCE=postgresql://root:secret@localhost:5432/golive_cms?sslmode=disable
//	ACCESS_TOKEN_DURATION=15m
//	REFRESH_TOKEN_DURATION=720h
//	COOKIE_SECURE=false
//	PASETO_V4_LOCAL_KEY_HEX=64-char-hex-string
//
// Security note (production):
//   - Prefer loading PASETO keys from a secrets manager or file path instead of
//     embedding raw keys in environment variables.
//   - In development, leave CookieDomain empty and CookieSecure=false.
type Config struct {
	// DBDriver selects the database driver (e.g. "postgres")
	DBDriver string `mapstructure:"DB_DRIVER"`

	// DBSource is the database connection string
	DBSource string `mapstructure:"DB_SOURCE"`

	// ServerAddress is the full bind address for the HTTP server (e.g. "0.0.0.0:8080")
	ServerAddress string `mapstructure:"SERVER_ADDRESS"`

	// APIPort is the colon-prefixed port used by CLIs/reverse-proxy config;
	// ServerAddress is the full bind address (e.g. ":8080")
	APIPort string `mapstructure:"API_PORT"`

	// Deprecated: Use PASETO v4 keys instead. Kept for legacy JWT paths.
	TokenSymmetricKey string `mapstructure:"TOKEN_SYMMETRIC_KEY"`

	// AccessTokenDuration is the validity period for access tokens (e.g. "15m")
	// Accepts time.ParseDuration formats: 10s, 15m, 24h, etc.
	AccessTokenDuration time.Duration `mapstructure:"ACCESS_TOKEN_DURATION"`

	// RefreshTokenDuration is the validity period for refresh tokens (e.g. "720h" = 30d)
	// Accepts time.ParseDuration formats: 10s, 15m, 24h, etc.
	RefreshTokenDuration time.Duration `mapstructure:"REFRESH_TOKEN_DURATION"`

	// MaxUploadSize defines the maximum file upload size (e.g. "10MB", "50MB")
	// Expected format is human-readable size string
	MaxUploadSize string `mapstructure:"MAX_UPLOAD_SIZE"`

	// UploadPath is the directory where uploaded files are stored
	UploadPath string `mapstructure:"UPLOAD_PATH"`

	// IsTestMode toggles test utilities and mock behavior
	IsTestMode bool `mapstructure:"IS_TEST_MODE"`

	// PASETO v4 public key (Ed25519) for asymmetric operations (v4.public tokens)
	// Hex-encoded: public key = 32 bytes (64 hex chars), private key = 64 bytes (128 hex chars)
	PasetoV4PublicKeyHex string `mapstructure:"PASETO_V4_PUBLIC_KEY_HEX"`

	// PASETO v4 private key (Ed25519) for asymmetric operations (v4.public tokens)
	// Hex-encoded: private key = 64 bytes (128 hex chars)
	PasetoV4PrivateKeyHex string `mapstructure:"PASETO_V4_PRIVATE_KEY_HEX"`

	// PASETO v4 local key (XChaCha20-Poly1305) for symmetric operations (v4.local tokens)
	// Hex-encoded: 32 bytes (64 hex chars)
	PasetoV4LocalKeyHex string `mapstructure:"PASETO_V4_LOCAL_KEY_HEX"`

	// PasetoIssuer identifies the issuer of PASETO tokens (set in token footer/claims)
	PasetoIssuer string `mapstructure:"PASETO_ISSUER"`

	// PasetoAudience identifies the intended audience of issued PASETO tokens
	PasetoAudience string `mapstructure:"PASETO_AUDIENCE"`

	// PasetoAccessKID is the key identifier for access tokens, used for key rotation
	// Verifiers accept tokens by matching KID to select the correct verification key
	PasetoAccessKID string `mapstructure:"PASETO_ACCESS_KID"`

	// PasetoRefreshKID is the key identifier for refresh tokens, used for key rotation
	// Verifiers accept tokens by matching KID to select the correct verification key
	PasetoRefreshKID string `mapstructure:"PASETO_REFRESH_KID"`

	// CookieDomain specifies the Domain attribute for HTTP cookies
	// Leave empty in development to avoid cross-port cookie issues
	CookieDomain string `mapstructure:"COOKIE_DOMAIN"`

	// CookieSecure determines if cookies require HTTPS
	// Should be false in development, true in production
	CookieSecure bool `mapstructure:"COOKIE_SECURE"`

	// IsDevelopment enables development-mode behavior (verbose errors, debug logging, etc.)
	IsDevelopment bool `mapstructure:"IS_DEVELOPMENT"`

	// CollabServerURL is the internal base URL of the Yjs WebSocket server.
	// Used for server-to-server calls such as the squash-on-publish endpoint.
	// Example: "http://websocket:1234" (Docker) or "http://localhost:1234" (local dev)
	CollabServerURL string `mapstructure:"COLLAB_SERVER_URL"`

	// CollabSquashSecret is the shared secret sent as "Authorization: Bearer <secret>"
	// to the WS server's /_internal/documents/:docName/squash endpoint.
	// Must match SQUASH_SECRET in websocket/.env.
	CollabSquashSecret string `mapstructure:"COLLAB_SQUASH_SECRET"`
}

// LoadConfig reads app.env (optional) and environment variables into Config.
// Defaults are applied for a functional local development experience.
//
// The function searches for a configuration file named "app.env" in the specified path.
// If the config file is not found, it continues with environment variables and defaults.
// All duration fields accept time.ParseDuration formats (e.g., "15m", "720h").
//
// Parameters:
//   - path: The directory path where to look for the config file
//
// Returns:
//   - config: A Config struct populated with configuration values
//   - err: An error if the configuration could not be loaded or parsed
//
// Example:
//
//	config, err := LoadConfig(".")
//	if err != nil {
//	    log.Fatal("Failed to load config:", err)
//	}
func LoadConfig(path string) (config Config, err error) {
	viper.AddConfigPath(path)
	viper.SetConfigName("app")
	viper.SetConfigType("env")
	viper.AutomaticEnv()

	// Database defaults (local development)
	viper.SetDefault("DB_DRIVER", "postgres")
	viper.SetDefault("DB_SOURCE", "postgresql://root:secret@localhost:5432/golive_cms?sslmode=disable")

	// Server defaults
	viper.SetDefault("SERVER_ADDRESS", "0.0.0.0:8080")
	viper.SetDefault("API_PORT", ":8080")

	// Token duration defaults
	viper.SetDefault("ACCESS_TOKEN_DURATION", "15m")   // 15 minutes
	viper.SetDefault("REFRESH_TOKEN_DURATION", "720h") // 30 days

	// Upload defaults
	viper.SetDefault("MAX_UPLOAD_SIZE", "10MB")
	viper.SetDefault("UPLOAD_PATH", "./uploads")

	// PASETO defaults
	viper.SetDefault("PASETO_ISSUER", "golive.auth")
	viper.SetDefault("PASETO_AUDIENCE", "golive.admin")
	viper.SetDefault("PASETO_ACCESS_KID", "k4.pub.2025-09")
	viper.SetDefault("PASETO_REFRESH_KID", "k4.loc.2025-09")

	// Cookie defaults (development-safe)
	viper.SetDefault("COOKIE_DOMAIN", "")    // Empty in dev to avoid cross-port issues
	viper.SetDefault("COOKIE_SECURE", false) // false in dev, should be true in production

	// Environment defaults
	viper.SetDefault("IS_DEVELOPMENT", true)

	// Legacy JWT key default (deprecated)
	viper.SetDefault("TOKEN_SYMMETRIC_KEY", "12345678901234567890123456789012")

	// Collaborative editing server (optional — squash silently skipped if unset)
	viper.SetDefault("COLLAB_SERVER_URL", "http://localhost:1234")
	viper.SetDefault("COLLAB_SQUASH_SECRET", "")

	// Try to read config file (optional)
	if err = viper.ReadInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			return config, err
		}
		// Config file not found is acceptable, continue with env vars and defaults
	}

	// Unmarshal configuration
	if err = viper.Unmarshal(&config); err != nil {
		return config, err
	}

	return config, nil
}
