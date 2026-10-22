package db

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestSQLStorePing(t *testing.T) {
	pinger, ok := testStore.(interface{ Ping(context.Context) error })
	require.True(t, ok, "SQLStore must implement Ping for the API's /readyz")

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	require.NoError(t, pinger.Ping(ctx))
}
