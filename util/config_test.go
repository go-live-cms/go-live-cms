package util

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// ROLE_LOOKUP_SECRET has no default, so it must still be read when it is set
// only in the environment (as compose does) and absent from app.env.
func TestLoadConfigReadsRoleLookupSecretFromEnv(t *testing.T) {
	t.Setenv("ROLE_LOOKUP_SECRET", "from-env")

	config, err := LoadConfig(t.TempDir()) // no app.env here
	require.NoError(t, err)
	require.Equal(t, "from-env", config.RoleLookupSecret)
}
