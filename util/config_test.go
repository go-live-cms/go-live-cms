package util

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestLoadConfigGinMode(t *testing.T) {
	testCases := []struct {
		name    string
		env     string
		set     bool
		want    string
		wantErr bool
	}{
		{name: "defaults to release", want: GinModeRelease},
		{name: "debug", env: "debug", set: true, want: GinModeDebug},
		{name: "rejects non-lowercase", env: "Release", set: true, wantErr: true},
		{name: "rejects surrounding spaces", env: " release ", set: true, wantErr: true},
		{name: "test", env: "test", set: true, want: GinModeTest},
		{name: "invalid", env: "production", set: true, wantErr: true},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.set {
				t.Setenv("GIN_MODE", tc.env)
			} else {
				t.Setenv("GIN_MODE", "")
			}

			// A temp dir has no app.env, so only env vars and defaults apply.
			config, err := LoadConfig(t.TempDir())
			if tc.wantErr {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
			require.Equal(t, tc.want, config.GinMode)
		})
	}
}

func TestLoadConfigCollabBackend(t *testing.T) {
	t.Setenv("COLLAB_BACKEND", "")
	config, err := LoadConfig(t.TempDir())
	require.NoError(t, err)
	require.Equal(t, CollabBackendYWebsocket, config.CollabBackend)
	require.False(t, config.UsesHocuspocus())

	t.Setenv("COLLAB_BACKEND", "hocuspocus")
	t.Setenv("COLLAB_INTERNAL_URL", "http://collab:1235")
	t.Setenv("COLLAB_INTERNAL_SECRET", "s3cret")
	config, err = LoadConfig(t.TempDir())
	require.NoError(t, err)
	require.True(t, config.UsesHocuspocus())
	require.Equal(t, "http://collab:1235", config.CollabInternalURL)
	require.Equal(t, "s3cret", config.CollabInternalSecret)

	t.Setenv("COLLAB_BACKEND", "Hocuspocus")
	_, err = LoadConfig(t.TempDir())
	require.ErrorContains(t, err, "COLLAB_BACKEND")
}

func TestAllowedOrigins(t *testing.T) {
	require.Empty(t, Config{}.AllowedOrigins())
	require.Equal(t,
		[]string{"https://a.example", "https://b.example"},
		Config{CORSAllowedOrigins: " https://a.example, ,https://b.example ,"}.AllowedOrigins(),
	)
}

// ROLE_LOOKUP_SECRET has no default, so it must still be read when it is set
// only in the environment (as compose does) and absent from app.env.
func TestLoadConfigReadsRoleLookupSecretFromEnv(t *testing.T) {
	t.Setenv("ROLE_LOOKUP_SECRET", "from-env")

	config, err := LoadConfig(t.TempDir()) // no app.env here
	require.NoError(t, err)
	require.Equal(t, "from-env", config.RoleLookupSecret)
}

// The PASETO keys have no defaults either. The API image has no app.env, so a
// deployment can only pass them as env vars; they must not be dropped.
func TestLoadConfigReadsPasetoKeysFromEnv(t *testing.T) {
	t.Setenv("PASETO_V4_PUBLIC_KEY_HEX", "pub-from-env")
	t.Setenv("PASETO_V4_PRIVATE_KEY_HEX", "priv-from-env")
	t.Setenv("PASETO_V4_LOCAL_KEY_HEX", "local-from-env")

	config, err := LoadConfig(t.TempDir()) // no app.env here
	require.NoError(t, err)
	require.Equal(t, "pub-from-env", config.PasetoV4PublicKeyHex)
	require.Equal(t, "priv-from-env", config.PasetoV4PrivateKeyHex)
	require.Equal(t, "local-from-env", config.PasetoV4LocalKeyHex)
}

func TestLoadConfigRateLimitDefaults(t *testing.T) {
	config, err := LoadConfig(t.TempDir())
	require.NoError(t, err)
	require.Equal(t, 600, config.RateLimitGeneralPerMinute)
	require.Equal(t, 10, config.RateLimitLoginPerMinute)
	require.Equal(t, 100, config.RateLimitLoginIPPerMinute)
	require.Equal(t, 30, config.RateLimitRefreshPerMinute)
	require.Equal(t, 5, config.RateLimitPasswordChangePerMinute)
	require.Empty(t, config.TrustedProxyList(), "no proxy is trusted by default")
}

func TestLoadConfigRejectsNegativeRateLimit(t *testing.T) {
	t.Setenv("RATE_LIMIT_LOGIN_PER_MINUTE", "-1")
	_, err := LoadConfig(t.TempDir())
	require.ErrorContains(t, err, "RATE_LIMIT_LOGIN_PER_MINUTE")
}

func TestTrustedProxyList(t *testing.T) {
	require.Equal(t,
		[]string{"10.0.0.0/8", "192.0.2.1"},
		Config{TrustedProxies: " 10.0.0.0/8, ,192.0.2.1"}.TrustedProxyList(),
	)
}

func TestMaxUploadBytes(t *testing.T) {
	testCases := []struct {
		in      string
		want    int64
		wantErr bool
	}{
		{in: "", want: DefaultMaxUploadBytes},
		{in: "10MB", want: 10 << 20},
		{in: " 512kb ", want: 512 << 10},
		{in: "1GB", want: 1 << 30},
		{in: "2048", want: 2048},
		{in: "100B", want: 100},
		{in: "0MB", wantErr: true},
		{in: "-1MB", wantErr: true},
		{in: "ten", wantErr: true},
		{in: "10TB", wantErr: true},
		{in: "99999999999GB", wantErr: true},
	}

	for _, tc := range testCases {
		t.Run(tc.in, func(t *testing.T) {
			got, err := Config{MaxUploadSize: tc.in}.MaxUploadBytes()
			if tc.wantErr {
				require.ErrorContains(t, err, "MAX_UPLOAD_SIZE")
				return
			}
			require.NoError(t, err)
			require.Equal(t, tc.want, got)
		})
	}
}

func TestLoadConfigRejectsInvalidMaxUploadSize(t *testing.T) {
	t.Setenv("MAX_UPLOAD_SIZE", "lots")
	_, err := LoadConfig(t.TempDir())
	require.ErrorContains(t, err, "MAX_UPLOAD_SIZE")
}

// Mail settings (#148) are passed as env vars in deployments; SMTP_PASS has no
// default, so it must be bound explicitly or viper drops it.
func TestLoadConfigReadsMailSettingsFromEnv(t *testing.T) {
	t.Setenv("SMTP_HOST", "smtp.example.com")
	t.Setenv("SMTP_PORT", "465")
	t.Setenv("SMTP_USER", "mailer")
	t.Setenv("SMTP_PASS", "pass-from-env")
	t.Setenv("MAIL_FROM", "CMS <no-reply@example.com>")
	t.Setenv("PUBLIC_BASE_URL", "https://cms.example.com/")

	config, err := LoadConfig(t.TempDir())
	require.NoError(t, err)
	require.Equal(t, "smtp.example.com", config.SMTPHost)
	require.Equal(t, 465, config.SMTPPort)
	require.Equal(t, "mailer", config.SMTPUser)
	require.Equal(t, "pass-from-env", config.SMTPPass)
	require.Equal(t, "CMS <no-reply@example.com>", config.MailFrom)
	require.Equal(t, 72*time.Hour, config.InvitationTTL)
	require.Equal(t, time.Hour, config.PasswordResetTTL)
	require.Equal(t, 5, config.RateLimitPasswordForgotPerMinute)
	require.Equal(t, 10, config.RateLimitAccountTokenPerMinute)

	url, err := config.PublicSiteURL()
	require.NoError(t, err)
	require.Equal(t, "https://cms.example.com", url, "trailing slash trimmed")
}

func TestLoadConfigRejectsNonPositiveLinkTTL(t *testing.T) {
	t.Setenv("PASSWORD_RESET_TTL", "0s")
	_, err := LoadConfig(t.TempDir())
	require.ErrorContains(t, err, "PASSWORD_RESET_TTL")
}

func TestMailDriverName(t *testing.T) {
	require.Equal(t, MailDriverFile, Config{GinMode: GinModeDebug}.MailDriverName())
	require.Equal(t, MailDriverLog, Config{IsTestMode: true}.MailDriverName())
	require.Equal(t, MailDriverSMTP, Config{GinMode: GinModeRelease}.MailDriverName())
	require.Equal(t, MailDriverSMTP, Config{GinMode: GinModeDebug, MailDriver: " SMTP "}.MailDriverName())
}

func TestPublicSiteURL(t *testing.T) {
	url, err := Config{GinMode: GinModeDebug}.PublicSiteURL()
	require.NoError(t, err)
	require.Equal(t, "http://localhost:4321", url)

	_, err = Config{GinMode: GinModeRelease}.PublicSiteURL()
	require.ErrorContains(t, err, "PUBLIC_BASE_URL is required")

	for _, bad := range []string{"cms.example.com", "ftp://cms.example.com", "https://", "https://u:p@cms.example.com", "https://cms.example.com#x"} {
		_, err = Config{GinMode: GinModeRelease, PublicBaseURL: bad}.PublicSiteURL()
		require.Error(t, err, bad)
	}

	url, err = Config{PublicBaseURL: "https://example.com/cms/"}.PublicSiteURL()
	require.NoError(t, err)
	require.Equal(t, "https://example.com/cms", url)
}

func TestLinkTTLDefaults(t *testing.T) {
	require.Equal(t, DefaultInvitationTTL, Config{}.InvitationLinkTTL())
	require.Equal(t, DefaultPasswordResetTTL, Config{}.PasswordResetLinkTTL())
	require.Equal(t, time.Minute, Config{PasswordResetTTL: time.Minute}.PasswordResetLinkTTL())
}

// Previous PASETO keys (key rotation, #139) are env-only like the current ones,
// and need an end of grace window.
func TestLoadConfigReadsPreviousPasetoKeysFromEnv(t *testing.T) {
	t.Setenv("PASETO_V4_PREVIOUS_PUBLIC_KEY_HEX", "old-pub")
	t.Setenv("PASETO_V4_PREVIOUS_LOCAL_KEY_HEX", "old-local")
	t.Setenv("PASETO_PREVIOUS_KEYS_VALID_UNTIL", "2026-11-01T00:00:00Z")

	config, err := LoadConfig(t.TempDir())
	require.NoError(t, err)
	require.Equal(t, "old-pub", config.PasetoV4PreviousPublicKeyHex)
	require.Equal(t, "old-local", config.PasetoV4PreviousLocalKeyHex)
	until, err := config.PasetoPreviousKeysUntil()
	require.NoError(t, err)
	require.Equal(t, time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC), until.UTC())
}

func TestPasetoPreviousKeysUntil(t *testing.T) {
	until, err := Config{}.PasetoPreviousKeysUntil()
	require.NoError(t, err)
	require.True(t, until.IsZero(), "no previous key, no window")

	for _, value := range []string{"", "tomorrow", "2026-11-01"} {
		_, err := Config{PasetoV4PreviousPublicKeyHex: "k", PasetoPreviousKeysValidUntil: value}.PasetoPreviousKeysUntil()
		require.ErrorContains(t, err, "PASETO_PREVIOUS_KEYS_VALID_UNTIL", value)
	}
}

func TestLoadConfigRejectsPreviousKeyWithoutWindow(t *testing.T) {
	t.Setenv("PASETO_V4_PREVIOUS_LOCAL_KEY_HEX", "old-local")
	_, err := LoadConfig(t.TempDir())
	require.ErrorContains(t, err, "PASETO_PREVIOUS_KEYS_VALID_UNTIL")
}
