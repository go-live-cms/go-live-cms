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
