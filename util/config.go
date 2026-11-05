// Package util provides configuration loading and utilities for Go Live CMS.
//
// Configuration is sourced from environment variables (via viper) and an optional
// app.env file. All exported fields are safe to reference across the codebase.
package util

import (
	"fmt"
	"io"
	"net/url"
	"os"
	"strconv"
	"strings"
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
//   - Secrets (secretFileSettings) can be read from files instead: set <KEY>_FILE to
//     a path, e.g. a compose secret under /run/secrets or a file a secrets
//     manager's agent writes. compose.yaml does that for the PASETO keys and the
//     shared secrets (docs/operations/deploy.md, "Secrets").
//   - In development (GIN_MODE=debug), leave CookieDomain empty and CookieSecure=false.
//     Outside debug mode the Secure flag is always set and CookieSecure is ignored.
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

	// AccessTokenDuration is the validity period for access tokens (e.g. "15m")
	// Accepts time.ParseDuration formats: 10s, 15m, 24h, etc.
	AccessTokenDuration time.Duration `mapstructure:"ACCESS_TOKEN_DURATION"`

	// RefreshTokenDuration is the validity period for refresh tokens (e.g. "720h" = 30d)
	// Accepts time.ParseDuration formats: 10s, 15m, 24h, etc.
	RefreshTokenDuration time.Duration `mapstructure:"REFRESH_TOKEN_DURATION"`

	// MaxUploadSize is the largest file a single media upload or replace may
	// carry (e.g. "10MB", "512KB", "1GB"; 1024-based, plain digits are bytes).
	// Larger files get 413. Use MaxUploadBytes for the parsed value; an empty
	// value means the 10MB default and an invalid one fails LoadConfig.
	MaxUploadSize string `mapstructure:"MAX_UPLOAD_SIZE"`

	// UploadPath is the directory where uploaded files are stored
	UploadPath string `mapstructure:"UPLOAD_PATH"`

	// IsTestMode toggles test utilities and mock behavior
	IsTestMode bool `mapstructure:"IS_TEST_MODE"`

	// GinMode is the Gin engine mode: "release" (default), "debug" or "test",
	// lowercase and exact (gin itself panics on other GIN_MODE env values).
	// Debug mode enables the dev CORS allowlist and seeds the default admin
	// (admin/123456) plus dummy data on startup, so only set it in development.
	GinMode string `mapstructure:"GIN_MODE"`

	// CORSAllowedOrigins is a comma-separated list of origins allowed to make
	// credentialed cross-origin requests (e.g. "https://admin.example.com").
	// In debug mode the local dev origins are always allowed as well. When empty
	// in release mode, no CORS headers are sent (same-origin only).
	CORSAllowedOrigins string `mapstructure:"CORS_ALLOWED_ORIGINS"`

	// SeedAdminUsername and SeedAdminPassword are the credentials the dev seed
	// (debug-mode startup and cmd/seed) gives the admin account it creates.
	// Empty means the defaults, admin / 123456 (devModeUtil.AdminAccount).
	SeedAdminUsername string `mapstructure:"SEED_ADMIN_USER"`
	SeedAdminPassword string `mapstructure:"SEED_ADMIN_PASS"`

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

	// Key rotation (#139, #158, docs/operations/key-rotation.md). The retired
	// public keys (access tokens) and/or local keys (refresh tokens), as
	// comma-separated kid=hex entries (the KID their tokens carry), keep
	// verifying tokens until PASETO_PREVIOUS_KEYS_VALID_UNTIL (RFC 3339), which
	// is required when either is set. New tokens always use the current keys.
	// Parsed by PasetoPreviousPublicKeys / PasetoPreviousLocalKeys.
	PasetoV4PreviousPublicKeys   string `mapstructure:"PASETO_V4_PREVIOUS_PUBLIC_KEYS"`
	PasetoV4PreviousLocalKeys    string `mapstructure:"PASETO_V4_PREVIOUS_LOCAL_KEYS"`
	PasetoPreviousKeysValidUntil string `mapstructure:"PASETO_PREVIOUS_KEYS_VALID_UNTIL"`

	// CookieDomain specifies the Domain attribute for the non-Secure refresh
	// cookie (debug mode with COOKIE_SECURE=false; "localhost" is dropped).
	// A Secure refresh cookie is __Host-refresh_token, which must not have a
	// Domain, so it ignores this (#159).
	CookieDomain string `mapstructure:"COOKIE_DOMAIN"`

	// CookieSecure sets the Secure flag on auth cookies, but is only read in
	// debug mode (GIN_MODE=debug) so local HTTP works. Every other mode forces Secure.
	CookieSecure bool `mapstructure:"COOKIE_SECURE"`

	// CollabInternalURL is the base URL of the collab (Hocuspocus) server's
	// internal HTTP endpoints, used for the API's server-to-server calls to it:
	// the flush before a publish (#206). Required (NewServer checks).
	// Example: "http://collab:1236" (Docker) or "http://localhost:1236" (local dev).
	CollabInternalURL string `mapstructure:"COLLAB_INTERNAL_URL"`

	// CollabInternalSecret is the shared secret sent as "Authorization: Bearer
	// <secret>" on those calls. Must match the collab server's
	// COLLAB_INTERNAL_SECRET.
	CollabInternalSecret string `mapstructure:"COLLAB_INTERNAL_SECRET"`

	// InternalServerAddress is the bind address of the separate server-to-server
	// listener (e.g. "0.0.0.0:8081") that serves /internal/* routes. Never publish
	// this port; only the collab server on the private network should reach it.
	InternalServerAddress string `mapstructure:"INTERNAL_SERVER_ADDRESS"`

	// RoleLookupSecret is the shared secret the collab server sends as
	// "Authorization: Bearer <secret>" on its internal calls (GET
	// /internal/users/:id/access, its per-connection access check, and the
	// /internal/posts/:id/collab load and store). Must match its ROLE_LOOKUP_SECRET.
	// Required: NewServer refuses to start without it (no default).
	RoleLookupSecret string `mapstructure:"ROLE_LOOKUP_SECRET"`

	// TrustedProxies is a comma-separated list of proxy IPs/CIDRs whose
	// X-Forwarded-For / X-Real-IP headers are believed when working out the
	// client IP (rate limiting, session IPs). Empty (the default) trusts no
	// proxy: the client IP is the TCP peer, so the headers can't be spoofed.
	// Set it to your reverse proxy / load balancer addresses.
	TrustedProxies string `mapstructure:"TRUSTED_PROXIES"`

	// Rate limits, in requests per minute per client IP (token bucket: the full
	// minute's allowance may be spent at once, then it refills evenly). 0
	// disables that limit. LoadConfig defaults them; a zero Config (tests) has
	// every limit off.
	//
	// RateLimitGeneralPerMinute applies to every public API request.
	RateLimitGeneralPerMinute int `mapstructure:"RATE_LIMIT_GENERAL_PER_MINUTE"`
	// RateLimitLoginPerMinute applies to POST /auth/login per client IP *and*
	// username, and to POST /auth/register per client IP.
	RateLimitLoginPerMinute int `mapstructure:"RATE_LIMIT_LOGIN_PER_MINUTE"`
	// RateLimitLoginIPPerMinute caps POST /auth/login per client IP across all
	// usernames (credential spraying). Keep it well above
	// RateLimitLoginPerMinute so clients sharing an IP aren't easily locked out.
	RateLimitLoginIPPerMinute int `mapstructure:"RATE_LIMIT_LOGIN_IP_PER_MINUTE"`
	// RateLimitRefreshPerMinute applies to POST /auth/refresh.
	RateLimitRefreshPerMinute int `mapstructure:"RATE_LIMIT_REFRESH_PER_MINUTE"`
	// RateLimitPasswordChangePerMinute applies to self password changes
	// (PUT /users/:id with a password), per user and client IP, so a stolen
	// token's guesses can't block the owner's own password change.
	RateLimitPasswordChangePerMinute int `mapstructure:"RATE_LIMIT_PASSWORD_CHANGE_PER_MINUTE"`

	// RateLimitPasswordForgotPerMinute applies to POST /auth/password/forgot
	// per client IP (each allowed request may send an email).
	RateLimitPasswordForgotPerMinute int `mapstructure:"RATE_LIMIT_PASSWORD_FORGOT_PER_MINUTE"`
	// RateLimitAccountTokenPerMinute applies per client IP to the endpoints
	// that redeem an emailed token: POST /auth/password/reset and
	// /auth/invitations/{preview,accept}.
	RateLimitAccountTokenPerMinute int `mapstructure:"RATE_LIMIT_ACCOUNT_TOKEN_PER_MINUTE"`
	// RateLimitAccessRequestPerMinute applies to POST /posts/:id/access-requests
	// (#321) per member and client IP: each request emails the post's reviewers.
	RateLimitAccessRequestPerMinute int `mapstructure:"RATE_LIMIT_ACCESS_REQUEST_PER_MINUTE"`

	// Outgoing email (#148): invitations and password resets.
	//
	// MailDriver is "smtp", "file" or "log". Empty picks "file" in debug mode
	// and "smtp" otherwise. "file" and "log" are refused outside debug and test
	// mode, and "smtp" needs SMTPHost and MailFrom: the API won't start in
	// release without a working mail setup (see mailer.New).
	MailDriver string `mapstructure:"MAIL_DRIVER"`
	// SMTPHost and SMTPPort locate the SMTP server; SMTPTLS says how the
	// connection is encrypted.
	SMTPHost string `mapstructure:"SMTP_HOST"`
	SMTPPort int    `mapstructure:"SMTP_PORT"`
	// SMTPTLS is "starttls" (TLS required, upgraded on connect), "tls"
	// (implicit TLS) or "none". Empty means "tls" on port 465 and "starttls"
	// otherwise. Emails carry working links, so "none" is only accepted in
	// debug/test mode or to a loopback host (a local relay).
	SMTPTLS string `mapstructure:"SMTP_TLS"`
	// SMTPUser and SMTPPass enable PLAIN auth (only over TLS, or to localhost).
	SMTPUser string `mapstructure:"SMTP_USER"`
	SMTPPass string `mapstructure:"SMTP_PASS"`
	// MailFrom is the sender, e.g. "GoLive CMS <no-reply@example.com>".
	MailFrom string `mapstructure:"MAIL_FROM"`
	// MailFileDir is where the "file" driver writes each email as a .eml file.
	MailFileDir string `mapstructure:"MAIL_FILE_DIR"`

	// PublicBaseURL is the site origin the admin is served from, e.g.
	// "https://cms.example.com"; email links point at it. Required outside
	// debug mode (where it defaults to http://localhost:4321). It is never
	// taken from the request's Host header, which a client controls.
	PublicBaseURL string `mapstructure:"PUBLIC_BASE_URL"`

	// InvitationTTL and PasswordResetTTL are how long an emailed link works.
	InvitationTTL    time.Duration `mapstructure:"INVITATION_TTL"`
	PasswordResetTTL time.Duration `mapstructure:"PASSWORD_RESET_TTL"`

	// ScheduledPublishInterval is how often the API looks for scheduled posts
	// that are due (#147, api/scheduled_publish.go). 30s by default, so a post
	// goes live within a minute of its time; 0 turns the scheduler off in this
	// process (another replica may still run it). Tests shorten it.
	ScheduledPublishInterval time.Duration `mapstructure:"SCHEDULED_PUBLISH_INTERVAL"`

	// RateLimitExemptCIDRs is a comma-separated list of client IPs/CIDRs that
	// skip the general limit (the auth limits still apply). Use it for trusted
	// server-side callers that funnel many users through one address, such as
	// the web container's SSR requests.
	RateLimitExemptCIDRs string `mapstructure:"RATE_LIMIT_EXEMPT_CIDRS"`

	// LastActiveInterval is how stale a member's last_active_at (#333) must be
	// before an authenticated request, login or refresh stamps it again, so the
	// API writes it at most once per interval per user, never on every request.
	// LoadConfig defaults it to 5m; 0 turns tracking off (a zero Config: tests).
	LastActiveInterval time.Duration `mapstructure:"LAST_ACTIVE_INTERVAL"`

	// ActivityRetention is how long the activity log (#324, api/activity.go)
	// keeps an event; older ones are pruned hourly. LoadConfig defaults it to
	// 2160h (90 days); 0 keeps every event (a zero Config: tests).
	ActivityRetention time.Duration `mapstructure:"ACTIVITY_RETENTION"`
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
	viper.SetDefault("INTERNAL_SERVER_ADDRESS", "0.0.0.0:8081") // server-to-server only, never published

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
	viper.SetDefault("COOKIE_SECURE", false) // only read in debug mode; release forces Secure

	// Gin mode defaults to release so a deployment never seeds dev data or
	// opens the dev CORS allowlist unless debug is set explicitly.
	viper.SetDefault("GIN_MODE", GinModeRelease)
	viper.SetDefault("CORS_ALLOWED_ORIGINS", "")

	// Dev seed admin credentials; empty means admin / 123456.
	viper.SetDefault("SEED_ADMIN_USER", "")
	viper.SetDefault("SEED_ADMIN_PASS", "")

	// Collaborative editing server. The URL and secret are required (NewServer
	// checks): publish can't flush without them. Both default to empty rather
	// than to a guessed address, so a missing setting fails at startup.
	viper.SetDefault("COLLAB_INTERNAL_URL", "")
	viper.SetDefault("COLLAB_INTERNAL_SECRET", "")

	// Client IP and rate limiting. No trusted proxies by default, so
	// X-Forwarded-For can't be forged to dodge the limits. The general limit
	// is generous because in dev every browser request reaches the API through
	// the web container's proxy, i.e. from one IP.
	viper.SetDefault("TRUSTED_PROXIES", "")
	viper.SetDefault("RATE_LIMIT_GENERAL_PER_MINUTE", 600)
	viper.SetDefault("RATE_LIMIT_LOGIN_PER_MINUTE", 10)
	viper.SetDefault("RATE_LIMIT_LOGIN_IP_PER_MINUTE", 100)
	viper.SetDefault("RATE_LIMIT_REFRESH_PER_MINUTE", 30)
	viper.SetDefault("RATE_LIMIT_PASSWORD_CHANGE_PER_MINUTE", 5)
	viper.SetDefault("RATE_LIMIT_PASSWORD_FORGOT_PER_MINUTE", 5)
	viper.SetDefault("RATE_LIMIT_ACCOUNT_TOKEN_PER_MINUTE", 10)
	viper.SetDefault("RATE_LIMIT_ACCESS_REQUEST_PER_MINUTE", 3)
	viper.SetDefault("RATE_LIMIT_EXEMPT_CIDRS", "")

	// Members' "last active" (#333): written at most once per interval per user.
	viper.SetDefault("LAST_ACTIVE_INTERVAL", "5m")

	// Activity log (#324): Home reads the last few weeks; keep 90 days of history.
	viper.SetDefault("ACTIVITY_RETENTION", "2160h")

	// Email (#148). No SMTP defaults: release mode must be configured.
	viper.SetDefault("MAIL_DRIVER", "")
	viper.SetDefault("SMTP_HOST", "")
	viper.SetDefault("SMTP_PORT", 587)
	viper.SetDefault("SMTP_TLS", "")
	viper.SetDefault("SMTP_USER", "")
	viper.SetDefault("MAIL_FROM", "")
	viper.SetDefault("MAIL_FILE_DIR", "dev-mail")
	viper.SetDefault("PUBLIC_BASE_URL", "")
	viper.SetDefault("INVITATION_TTL", "72h")
	viper.SetDefault("PASSWORD_RESET_TTL", "1h")
	viper.SetDefault("SCHEDULED_PUBLISH_INTERVAL", "30s")

	// Required, so deliberately no default. Bind it explicitly instead: viper's
	// Unmarshal only sees AutomaticEnv values for keys it already knows from a
	// default or app.env, so without this a ROLE_LOOKUP_SECRET set only in the
	// environment (e.g. compose) would be silently dropped.
	// The same goes for the PASETO keys: secrets with no safe default, which a
	// deployment passes as env vars (the API image no longer bakes in app.env).
	for _, key := range []string{
		"ROLE_LOOKUP_SECRET",
		"PASETO_V4_PUBLIC_KEY_HEX",
		"PASETO_V4_PRIVATE_KEY_HEX",
		"PASETO_V4_LOCAL_KEY_HEX",
		"SMTP_PASS",
		"PASETO_V4_PREVIOUS_PUBLIC_KEYS",
		"PASETO_V4_PREVIOUS_LOCAL_KEYS",
		"PASETO_PREVIOUS_KEYS_VALID_UNTIL",
		// Read only to refuse them (renamedConfigKeys).
		"PASETO_V4_PREVIOUS_PUBLIC_KEY_HEX",
		"PASETO_V4_PREVIOUS_LOCAL_KEY_HEX",
	} {
		if err = viper.BindEnv(key); err != nil {
			return config, err
		}
	}

	// Try to read config file (optional)
	if err = viper.ReadInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			return config, err
		}
		// Config file not found is acceptable, continue with env vars and defaults
	}

	// A renamed setting would otherwise be dropped without a word, e.g. a
	// rotation that looks configured but accepts no old token.
	for old, replacement := range renamedConfigKeys {
		if viper.GetString(old) != "" {
			return config, fmt.Errorf("%s is no longer read: use %s (docs/operations/key-rotation.md)", old, replacement)
		}
	}

	// Unmarshal configuration
	if err = viper.Unmarshal(&config); err != nil {
		return config, err
	}

	for _, secret := range secretFileSettings {
		value, ok, err := readSecretFile(secret.key)
		if err != nil {
			return config, err
		}
		if ok {
			*secret.field(&config) = value
		}
	}

	// Exact values only, no case/space normalization: gin's own init() reads the
	// GIN_MODE env var and panics on anything else before LoadConfig runs, so
	// accepting " Release " here would only ever work from app.env.
	switch config.GinMode {
	case GinModeDebug, GinModeRelease, GinModeTest:
	default:
		return config, fmt.Errorf("invalid GIN_MODE %q: must be %q, %q or %q",
			config.GinMode, GinModeDebug, GinModeRelease, GinModeTest)
	}

	if _, err = config.MaxUploadBytes(); err != nil {
		return config, err
	}

	if config.InvitationTTL <= 0 || config.PasswordResetTTL <= 0 {
		return config, fmt.Errorf("INVITATION_TTL and PASSWORD_RESET_TTL must be positive durations")
	}

	if config.ScheduledPublishInterval < 0 {
		return config, fmt.Errorf("SCHEDULED_PUBLISH_INTERVAL must be 0 (off) or a positive duration")
	}

	if config.ActivityRetention < 0 {
		return config, fmt.Errorf("ACTIVITY_RETENTION must be 0 (keep everything) or a positive duration")
	}

	if _, err = config.PasetoPreviousPublicKeys(); err != nil {
		return config, err
	}
	if _, err = config.PasetoPreviousLocalKeys(); err != nil {
		return config, err
	}
	if _, err = config.PasetoPreviousKeysUntil(); err != nil {
		return config, err
	}

	for name, v := range map[string]int{
		"RATE_LIMIT_GENERAL_PER_MINUTE":         config.RateLimitGeneralPerMinute,
		"RATE_LIMIT_LOGIN_PER_MINUTE":           config.RateLimitLoginPerMinute,
		"RATE_LIMIT_LOGIN_IP_PER_MINUTE":        config.RateLimitLoginIPPerMinute,
		"RATE_LIMIT_REFRESH_PER_MINUTE":         config.RateLimitRefreshPerMinute,
		"RATE_LIMIT_PASSWORD_CHANGE_PER_MINUTE": config.RateLimitPasswordChangePerMinute,
		"RATE_LIMIT_PASSWORD_FORGOT_PER_MINUTE": config.RateLimitPasswordForgotPerMinute,
		"RATE_LIMIT_ACCOUNT_TOKEN_PER_MINUTE":   config.RateLimitAccountTokenPerMinute,
		"RATE_LIMIT_ACCESS_REQUEST_PER_MINUTE":  config.RateLimitAccessRequestPerMinute,
	} {
		if v < 0 {
			return config, fmt.Errorf("invalid %s %d: must be >= 0 (0 disables the limit)", name, v)
		}
	}

	return config, nil
}

// DefaultMaxUploadBytes is the upload limit used when MAX_UPLOAD_SIZE is empty.
const DefaultMaxUploadBytes int64 = 10 << 20

// MaxUploadBytes returns MaxUploadSize in bytes: DefaultMaxUploadBytes when
// it is empty (a zero Config in tests), an error when it doesn't parse or
// isn't positive.
func (c Config) MaxUploadBytes() (int64, error) {
	s := strings.ToUpper(strings.TrimSpace(c.MaxUploadSize))
	if s == "" {
		return DefaultMaxUploadBytes, nil
	}

	multiplier := int64(1)
	for _, unit := range []struct {
		suffix string
		mult   int64
	}{{"GB", 1 << 30}, {"MB", 1 << 20}, {"KB", 1 << 10}, {"B", 1}} {
		if strings.HasSuffix(s, unit.suffix) {
			multiplier = unit.mult
			s = strings.TrimSpace(strings.TrimSuffix(s, unit.suffix))
			break
		}
	}

	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n <= 0 || n > (1<<62)/multiplier {
		return 0, fmt.Errorf("invalid MAX_UPLOAD_SIZE %q: want a positive size such as 10MB, 512KB or 1GB", c.MaxUploadSize)
	}
	return n * multiplier, nil
}

// splitList splits a comma-separated config value, trimming entries and
// dropping empty ones.
func splitList(s string) []string {
	var out []string
	for _, v := range strings.Split(s, ",") {
		if v = strings.TrimSpace(v); v != "" {
			out = append(out, v)
		}
	}
	return out
}

// TrustedProxyList returns TrustedProxies as a list (nil when empty, which
// trusts no proxy). gin validates the entries.
func (c Config) TrustedProxyList() []string {
	return splitList(c.TrustedProxies)
}

// RateLimitExemptList returns RateLimitExemptCIDRs as a list.
func (c Config) RateLimitExemptList() []string {
	return splitList(c.RateLimitExemptCIDRs)
}

// Gin engine modes accepted by GIN_MODE. They match gin.DebugMode,
// gin.ReleaseMode and gin.TestMode (util doesn't import gin).
const (
	GinModeDebug   = "debug"
	GinModeRelease = "release"
	GinModeTest    = "test"
)

// IsDebugMode reports whether GIN_MODE is "debug", the only mode that seeds
// dev data, allows the local dev CORS origins and lets COOKIE_SECURE drop the
// Secure flag from auth cookies.
func (c Config) IsDebugMode() bool {
	return c.GinMode == GinModeDebug
}

// Mail drivers accepted by MAIL_DRIVER (see Config.MailDriver).
const (
	MailDriverSMTP = "smtp"
	MailDriverFile = "file"
	MailDriverLog  = "log"
)

// MailDriverName returns the mail driver to use: MailDriver lowercased, or
// when it is empty "file" in debug mode, "log" in test mode and "smtp"
// otherwise. mailer.New validates the result.
func (c Config) MailDriverName() string {
	if d := strings.ToLower(strings.TrimSpace(c.MailDriver)); d != "" {
		return d
	}
	switch {
	case c.IsDebugMode():
		return MailDriverFile
	case c.IsTestMode:
		return MailDriverLog
	default:
		return MailDriverSMTP
	}
}

// devPublicBaseURL is the web dev server, used for links in debug mode when
// PUBLIC_BASE_URL is unset.
const devPublicBaseURL = "http://localhost:4321"

// PublicSiteURL returns PublicBaseURL without a trailing slash. In debug and
// test mode an empty value means the local web dev server; otherwise it is
// required. It must be an absolute http(s) URL with no query or fragment.
func (c Config) PublicSiteURL() (string, error) {
	raw := strings.TrimRight(strings.TrimSpace(c.PublicBaseURL), "/")
	if raw == "" {
		if c.IsDebugMode() || c.IsTestMode {
			return devPublicBaseURL, nil
		}
		return "", fmt.Errorf("PUBLIC_BASE_URL is required outside debug mode (the site URL used in invitation and password reset emails)")
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return "", fmt.Errorf("invalid PUBLIC_BASE_URL %q: want an absolute http(s) URL such as https://cms.example.com", c.PublicBaseURL)
	}
	return raw, nil
}

// Default link lifetimes, used when the TTLs are zero (a zero Config in tests).
const (
	DefaultInvitationTTL    = 72 * time.Hour
	DefaultPasswordResetTTL = time.Hour
)

// InvitationLinkTTL returns InvitationTTL, or DefaultInvitationTTL when unset.
func (c Config) InvitationLinkTTL() time.Duration {
	if c.InvitationTTL > 0 {
		return c.InvitationTTL
	}
	return DefaultInvitationTTL
}

// PasswordResetLinkTTL returns PasswordResetTTL, or DefaultPasswordResetTTL
// when unset.
func (c Config) PasswordResetLinkTTL() time.Duration {
	if c.PasswordResetTTL > 0 {
		return c.PasswordResetTTL
	}
	return DefaultPasswordResetTTL
}

// AllowedOrigins returns CORSAllowedOrigins split on commas, trimmed, with
// empty entries dropped.
func (c Config) AllowedOrigins() []string {
	return splitList(c.CORSAllowedOrigins)
}

// renamedConfigKeys maps settings that are no longer read to their
// replacements. LoadConfig refuses to start while an old one is set.
var renamedConfigKeys = map[string]string{
	// #158: one unnamed key became a kid=hex list.
	"PASETO_V4_PREVIOUS_PUBLIC_KEY_HEX": "PASETO_V4_PREVIOUS_PUBLIC_KEYS=<kid>=<hex>",
	"PASETO_V4_PREVIOUS_LOCAL_KEY_HEX":  "PASETO_V4_PREVIOUS_LOCAL_KEYS=<kid>=<hex>",
}

// secretFileSettings are the settings that may also be read from a file: when
// <KEY>_FILE names one, LoadConfig uses its contents (surrounding whitespace,
// such as the trailing newline, trimmed) as KEY. Setting both KEY and
// <KEY>_FILE is an error, so it's never unclear which one is in use. This is
// the Docker/compose secrets convention (/run/secrets/<name>), and how a
// secrets manager plugs in: its agent or CSI driver writes the file.
var secretFileSettings = []struct {
	key   string
	field func(*Config) *string
}{
	{"DB_SOURCE", func(c *Config) *string { return &c.DBSource }},
	{"PASETO_V4_PUBLIC_KEY_HEX", func(c *Config) *string { return &c.PasetoV4PublicKeyHex }},
	{"PASETO_V4_PRIVATE_KEY_HEX", func(c *Config) *string { return &c.PasetoV4PrivateKeyHex }},
	{"PASETO_V4_LOCAL_KEY_HEX", func(c *Config) *string { return &c.PasetoV4LocalKeyHex }},
	{"PASETO_V4_PREVIOUS_PUBLIC_KEYS", func(c *Config) *string { return &c.PasetoV4PreviousPublicKeys }},
	{"PASETO_V4_PREVIOUS_LOCAL_KEYS", func(c *Config) *string { return &c.PasetoV4PreviousLocalKeys }},
	{"ROLE_LOOKUP_SECRET", func(c *Config) *string { return &c.RoleLookupSecret }},
	{"COLLAB_INTERNAL_SECRET", func(c *Config) *string { return &c.CollabInternalSecret }},
	{"SMTP_PASS", func(c *Config) *string { return &c.SMTPPass }},
}

// maxSecretFileBytes caps a <KEY>_FILE read: secrets are short, so anything
// bigger is the wrong path (a directory's worth of data, a device).
const maxSecretFileBytes = 64 << 10

// readSecretFile reads <key>_FILE (see secretFileSettings): the value and
// true, or false when <key>_FILE is unset. Errors name the variables and the
// path, never the contents.
func readSecretFile(key string) (string, bool, error) {
	fileKey := key + "_FILE"
	if err := viper.BindEnv(fileKey); err != nil {
		return "", false, err
	}
	path := strings.TrimSpace(viper.GetString(fileKey))
	if path == "" {
		return "", false, nil
	}
	if v, ok := os.LookupEnv(key); (ok && v != "") || viper.InConfig(key) {
		return "", false, fmt.Errorf("both %s and %s are set: use one", key, fileKey)
	}
	f, err := os.Open(path)
	if err != nil {
		return "", false, fmt.Errorf("%s: %w", fileKey, err)
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxSecretFileBytes+1))
	if err != nil {
		return "", false, fmt.Errorf("%s: reading %s: %w", fileKey, path, err)
	}
	if len(data) > maxSecretFileBytes {
		return "", false, fmt.Errorf("%s: %s is larger than %d bytes", fileKey, path, maxSecretFileBytes)
	}
	value := strings.TrimSpace(string(data))
	if value == "" {
		return "", false, fmt.Errorf("%s: %s is empty", fileKey, path)
	}
	return value, true, nil
}

// PasetoPreviousPublicKeys parses PASETO_V4_PREVIOUS_PUBLIC_KEYS into KID →
// hex public key (nil when unset). The keys themselves are checked by the
// token maker.
func (c Config) PasetoPreviousPublicKeys() (map[string]string, error) {
	return parseKIDKeys("PASETO_V4_PREVIOUS_PUBLIC_KEYS", c.PasetoV4PreviousPublicKeys)
}

// PasetoPreviousLocalKeys parses PASETO_V4_PREVIOUS_LOCAL_KEYS like
// PasetoPreviousPublicKeys.
func (c Config) PasetoPreviousLocalKeys() (map[string]string, error) {
	return parseKIDKeys("PASETO_V4_PREVIOUS_LOCAL_KEYS", c.PasetoV4PreviousLocalKeys)
}

// parseKIDKeys parses comma-separated kid=hex entries. Errors never include
// the key material.
func parseKIDKeys(name, value string) (map[string]string, error) {
	entries := splitList(value)
	if len(entries) == 0 {
		return nil, nil
	}
	keys := make(map[string]string, len(entries))
	for i, entry := range entries {
		kid, hex, ok := strings.Cut(entry, "=")
		kid, hex = strings.TrimSpace(kid), strings.TrimSpace(hex)
		if !ok || kid == "" || hex == "" {
			return nil, fmt.Errorf("invalid %s: entry %d is not <kid>=<hex key>", name, i+1)
		}
		// Written the wrong way round (<hex>=<kid>): the key is where the KID
		// goes, so never echo it.
		if len(kid) >= 32 && strings.Trim(strings.ToLower(kid), "0123456789abcdef") == "" {
			return nil, fmt.Errorf("invalid %s: entry %d has a hex key where the KID goes: write <kid>=<hex key>", name, i+1)
		}
		if _, dup := keys[kid]; dup {
			return nil, fmt.Errorf("invalid %s: KID %q is listed twice", name, kid)
		}
		keys[kid] = hex
	}
	return keys, nil
}

// PasetoPreviousKeysUntil parses PASETO_PREVIOUS_KEYS_VALID_UNTIL: the end of
// the key rotation grace window. It is zero when no previous key is set, and
// an error when a previous key is set without a valid RFC 3339 time.
func (c Config) PasetoPreviousKeysUntil() (time.Time, error) {
	if len(splitList(c.PasetoV4PreviousPublicKeys)) == 0 && len(splitList(c.PasetoV4PreviousLocalKeys)) == 0 {
		return time.Time{}, nil
	}
	until, err := time.Parse(time.RFC3339, strings.TrimSpace(c.PasetoPreviousKeysValidUntil))
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid PASETO_PREVIOUS_KEYS_VALID_UNTIL %q: a previous PASETO key needs an RFC 3339 end of grace window, e.g. 2026-11-01T00:00:00Z", c.PasetoPreviousKeysValidUntil)
	}
	return until, nil
}
