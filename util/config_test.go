package util

import (
	"os"
	"path/filepath"
	"strings"
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

func TestLoadConfigCollabInternal(t *testing.T) {
	t.Setenv("COLLAB_INTERNAL_URL", "")
	t.Setenv("COLLAB_INTERNAL_SECRET", "")
	config, err := LoadConfig(t.TempDir())
	require.NoError(t, err)
	require.Empty(t, config.CollabInternalURL)
	require.Empty(t, config.CollabInternalSecret)

	t.Setenv("COLLAB_INTERNAL_URL", "http://collab:1236")
	t.Setenv("COLLAB_INTERNAL_SECRET", "s3cret")
	config, err = LoadConfig(t.TempDir())
	require.NoError(t, err)
	require.Equal(t, "http://collab:1236", config.CollabInternalURL)
	require.Equal(t, "s3cret", config.CollabInternalSecret)
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

// The activity log (#324) keeps 90 days by default; 0 keeps everything.
func TestLoadConfigActivityRetention(t *testing.T) {
	config, err := LoadConfig(t.TempDir())
	require.NoError(t, err)
	require.Equal(t, 90*24*time.Hour, config.ActivityRetention)

	t.Setenv("ACTIVITY_RETENTION", "0")
	config, err = LoadConfig(t.TempDir())
	require.NoError(t, err)
	require.Zero(t, config.ActivityRetention)

	t.Setenv("ACTIVITY_RETENTION", "-1h")
	_, err = LoadConfig(t.TempDir())
	require.ErrorContains(t, err, "ACTIVITY_RETENTION")
}

// Plugin hooks (#458) run every second by default; 0 turns them off.
func TestLoadConfigPluginHooksInterval(t *testing.T) {
	config, err := LoadConfig(t.TempDir())
	require.NoError(t, err)
	require.Equal(t, time.Second, config.PluginHooksInterval)

	t.Setenv("PLUGIN_HOOKS_INTERVAL", "0")
	config, err = LoadConfig(t.TempDir())
	require.NoError(t, err)
	require.Zero(t, config.PluginHooksInterval)

	t.Setenv("PLUGIN_HOOKS_INTERVAL", "-1s")
	_, err = LoadConfig(t.TempDir())
	require.ErrorContains(t, err, "PLUGIN_HOOKS_INTERVAL")
}

// The webhook SSRF allowance (#460) is off by default and refused outside debug mode.
func TestLoadConfigPluginWebhooksAllowInsecure(t *testing.T) {
	config, err := LoadConfig(t.TempDir())
	require.NoError(t, err)
	require.False(t, config.PluginWebhooksAllowInsecure)

	t.Setenv("PLUGIN_WEBHOOKS_ALLOW_INSECURE", "true")
	for _, mode := range []string{GinModeRelease, GinModeTest} {
		t.Setenv("GIN_MODE", mode)
		_, err = LoadConfig(t.TempDir())
		require.ErrorContains(t, err, "PLUGIN_WEBHOOKS_ALLOW_INSECURE", mode)
	}
	t.Setenv("GIN_MODE", GinModeDebug)
	config, err = LoadConfig(t.TempDir())
	require.NoError(t, err)
	require.True(t, config.PluginWebhooksAllowInsecure)
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

// Previous PASETO keys (key rotation, #139, #158) are env-only like the current
// ones: kid=hex lists that need an end of grace window.
func TestLoadConfigReadsPreviousPasetoKeysFromEnv(t *testing.T) {
	t.Setenv("PASETO_V4_PREVIOUS_PUBLIC_KEYS", "k4.pub.2026-01=old-pub, k4.pub.2026-06 = older-pub")
	t.Setenv("PASETO_V4_PREVIOUS_LOCAL_KEYS", "k4.loc.2026-01=old-local")
	t.Setenv("PASETO_PREVIOUS_KEYS_VALID_UNTIL", "2026-11-01T00:00:00Z")

	config, err := LoadConfig(t.TempDir())
	require.NoError(t, err)
	public, err := config.PasetoPreviousPublicKeys()
	require.NoError(t, err)
	require.Equal(t, map[string]string{"k4.pub.2026-01": "old-pub", "k4.pub.2026-06": "older-pub"}, public)
	local, err := config.PasetoPreviousLocalKeys()
	require.NoError(t, err)
	require.Equal(t, map[string]string{"k4.loc.2026-01": "old-local"}, local)
	until, err := config.PasetoPreviousKeysUntil()
	require.NoError(t, err)
	require.Equal(t, time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC), until.UTC())
}

func TestPasetoPreviousKeysUntil(t *testing.T) {
	until, err := Config{}.PasetoPreviousKeysUntil()
	require.NoError(t, err)
	require.True(t, until.IsZero(), "no previous key, no window")

	for _, value := range []string{"", "tomorrow", "2026-11-01"} {
		_, err := Config{PasetoV4PreviousPublicKeys: "k=v", PasetoPreviousKeysValidUntil: value}.PasetoPreviousKeysUntil()
		require.ErrorContains(t, err, "PASETO_PREVIOUS_KEYS_VALID_UNTIL", value)
	}
}

func TestParsePreviousPasetoKeys(t *testing.T) {
	for _, value := range []string{"", " , "} {
		keys, err := Config{PasetoV4PreviousLocalKeys: value}.PasetoPreviousLocalKeys()
		require.NoError(t, err)
		require.Nil(t, keys, value)
	}

	for value, wantErr := range map[string]string{
		"deadbeef":              "entry 1 is not <kid>=<hex key>",
		"a=1,=2":                "entry 2 is not",
		"a=":                    "entry 1 is not",
		"a=1, a=2":              `KID "a" is listed twice`,
		"k4.loc.2026=secret,x=": "entry 2",
		// Reversed: the (secret) key where the KID goes.
		"5ec2e75ec2e75ec2e75ec2e75ec2e75ec2e75ec2e75ec2e75ec2e75ec2e75ec2=k4.loc.2026": "hex key where the KID goes",
	} {
		_, err := Config{PasetoV4PreviousLocalKeys: value}.PasetoPreviousLocalKeys()
		require.ErrorContains(t, err, "PASETO_V4_PREVIOUS_LOCAL_KEYS", value)
		require.ErrorContains(t, err, wantErr, value)
		require.NotContains(t, err.Error(), "secret", "key material in the error")
		require.NotContains(t, err.Error(), "5ec2e7", "key material in the error")
	}
}

func TestLoadConfigRejectsPreviousKeyWithoutWindow(t *testing.T) {
	t.Setenv("PASETO_V4_PREVIOUS_LOCAL_KEYS", "k4.loc.2026-01=old-local")
	_, err := LoadConfig(t.TempDir())
	require.ErrorContains(t, err, "PASETO_PREVIOUS_KEYS_VALID_UNTIL")

	t.Setenv("PASETO_PREVIOUS_KEYS_VALID_UNTIL", "2026-11-01T00:00:00Z")
	t.Setenv("PASETO_V4_PREVIOUS_LOCAL_KEYS", "no-kid")
	_, err = LoadConfig(t.TempDir())
	require.ErrorContains(t, err, "PASETO_V4_PREVIOUS_LOCAL_KEYS")
}

// The pre-#158 single-key settings are refused, not silently ignored.
func TestLoadConfigRefusesRenamedPreviousKeySettings(t *testing.T) {
	for old, replacement := range map[string]string{
		"PASETO_V4_PREVIOUS_PUBLIC_KEY_HEX": "PASETO_V4_PREVIOUS_PUBLIC_KEYS",
		"PASETO_V4_PREVIOUS_LOCAL_KEY_HEX":  "PASETO_V4_PREVIOUS_LOCAL_KEYS",
	} {
		t.Run(old, func(t *testing.T) {
			t.Setenv(old, "abc")
			_, err := LoadConfig(t.TempDir())
			require.ErrorContains(t, err, old)
			require.ErrorContains(t, err, replacement)
		})
	}
}

// writeSecret writes value to a file in a temp dir and returns its path.
func writeSecret(t *testing.T, value string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "secret")
	require.NoError(t, os.WriteFile(path, []byte(value), 0o600))
	return path
}

// <KEY>_FILE (#158): every secret can come from a file (compose secrets), with
// the trailing newline trimmed, and the plain variables keep working.
func TestLoadConfigReadsSecretFiles(t *testing.T) {
	for _, secret := range secretFileSettings {
		t.Run(secret.key, func(t *testing.T) {
			t.Setenv(secret.key, "")
			t.Setenv(secret.key+"_FILE", writeSecret(t, "  from-file-"+secret.key+"\n"))
			if strings.HasPrefix(secret.key, "PASETO_V4_PREVIOUS_") {
				t.Setenv(secret.key+"_FILE", writeSecret(t, "kid=from-file\n"))
				t.Setenv("PASETO_PREVIOUS_KEYS_VALID_UNTIL", "2026-11-01T00:00:00Z")
			}

			config, err := LoadConfig(t.TempDir())
			require.NoError(t, err)
			got := *secret.field(&config)
			if strings.HasPrefix(secret.key, "PASETO_V4_PREVIOUS_") {
				require.Equal(t, "kid=from-file", got)
				return
			}
			require.Equal(t, "from-file-"+secret.key, got)
		})
	}

	// Without _FILE the variable is read as before.
	t.Setenv("ROLE_LOOKUP_SECRET", "from-env")
	config, err := LoadConfig(t.TempDir())
	require.NoError(t, err)
	require.Equal(t, "from-env", config.RoleLookupSecret)
}

func TestLoadConfigSecretFileErrors(t *testing.T) {
	t.Run("both set", func(t *testing.T) {
		t.Setenv("ROLE_LOOKUP_SECRET", "from-env")
		t.Setenv("ROLE_LOOKUP_SECRET_FILE", writeSecret(t, "from-file"))
		_, err := LoadConfig(t.TempDir())
		require.ErrorContains(t, err, "both ROLE_LOOKUP_SECRET and ROLE_LOOKUP_SECRET_FILE")
	})
	t.Run("missing file", func(t *testing.T) {
		t.Setenv("COLLAB_INTERNAL_SECRET_FILE", filepath.Join(t.TempDir(), "nope"))
		_, err := LoadConfig(t.TempDir())
		require.ErrorContains(t, err, "COLLAB_INTERNAL_SECRET_FILE")
	})
	t.Run("empty file", func(t *testing.T) {
		t.Setenv("PASETO_V4_LOCAL_KEY_HEX", "")
		t.Setenv("PASETO_V4_LOCAL_KEY_HEX_FILE", writeSecret(t, " \n"))
		_, err := LoadConfig(t.TempDir())
		require.ErrorContains(t, err, "is empty")
	})
	t.Run("too large", func(t *testing.T) {
		t.Setenv("SMTP_PASS_FILE", writeSecret(t, strings.Repeat("x", maxSecretFileBytes+1)))
		_, err := LoadConfig(t.TempDir())
		require.ErrorContains(t, err, "larger than")
	})
	t.Run("never the contents", func(t *testing.T) {
		t.Setenv("PASETO_PREVIOUS_KEYS_VALID_UNTIL", "2026-11-01T00:00:00Z")
		t.Setenv("PASETO_V4_PREVIOUS_LOCAL_KEYS_FILE", writeSecret(t, "topsecretkeymaterial"))
		_, err := LoadConfig(t.TempDir())
		require.ErrorContains(t, err, "PASETO_V4_PREVIOUS_LOCAL_KEYS")
		require.NotContains(t, err.Error(), "topsecret")
	})
}
