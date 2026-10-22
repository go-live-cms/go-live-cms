package util

import (
	"testing"

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
