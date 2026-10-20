package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/golang/mock/gomock"
	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/util"
	"github.com/stretchr/testify/require"
)

func TestShouldSeedDevData(t *testing.T) {
	testCases := []struct {
		name     string
		ginMode  string
		testMode bool
		want     bool
	}{
		{name: "debug", ginMode: util.GinModeDebug, want: true},
		{name: "debug in tests", ginMode: util.GinModeDebug, testMode: true, want: false},
		{name: "release", ginMode: util.GinModeRelease, want: false},
		{name: "test", ginMode: util.GinModeTest, want: false},
		{name: "unset", ginMode: "", want: false},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			config := util.Config{GinMode: tc.ginMode, IsTestMode: tc.testMode}
			require.Equal(t, tc.want, shouldSeedDevData(config))
		})
	}
}

// TestNewServerSeedingGate runs NewServer with test mode off, so only GIN_MODE
// decides whether startup seeding touches the store. The themes directory
// doesn't exist relative to api/, so the theme sync makes no store calls.
func TestNewServerSeedingGate(t *testing.T) {
	t.Run("release creates no users", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl) // no expectations: any store call fails

		config := newTestServer(t, store).config
		config.IsTestMode = false
		config.GinMode = util.GinModeRelease

		_, err := NewServer(config, store)
		require.NoError(t, err)
	})

	t.Run("debug runs the seeders", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		// Existing admin and users make both seeders return early.
		store.EXPECT().
			GetUserByUsername(gomock.Any(), gomock.Eq("admin")).
			Times(1).
			Return(db.User{Username: "admin"}, nil)
		store.EXPECT().
			CountTotalUsers(gomock.Any()).
			Times(1).
			Return(int64(2), nil)

		config := newTestServer(t, store).config
		config.IsTestMode = false
		config.GinMode = util.GinModeDebug

		_, err := NewServer(config, store)
		require.NoError(t, err)
	})
}

func TestCORSOrigins(t *testing.T) {
	const prodOrigin = "https://admin.example.com"
	const devOrigin = "http://localhost:4321"

	testCases := []struct {
		name       string
		ginMode    string
		configured string
		origin     string
		wantAllow  bool
	}{
		{name: "release, none configured, dev origin", ginMode: util.GinModeRelease, origin: devOrigin},
		{name: "release, configured origin", ginMode: util.GinModeRelease, configured: prodOrigin, origin: prodOrigin, wantAllow: true},
		{name: "release, dev origin not configured", ginMode: util.GinModeRelease, configured: prodOrigin, origin: devOrigin},
		{name: "debug, dev origin", ginMode: util.GinModeDebug, origin: devOrigin, wantAllow: true},
		{name: "debug, configured origin", ginMode: util.GinModeDebug, configured: prodOrigin, origin: prodOrigin, wantAllow: true},
		{name: "debug, unknown origin", ginMode: util.GinModeDebug, origin: "https://evil.example"},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			server := newTestServer(t, mockdb.NewMockStore(ctrl))
			server.config.GinMode = tc.ginMode
			server.config.CORSAllowedOrigins = tc.configured
			server.setupRoutes()

			request, err := http.NewRequest(http.MethodGet, "/health", nil)
			require.NoError(t, err)
			request.Header.Set("Origin", tc.origin)

			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, request)

			allow := recorder.Header().Get("Access-Control-Allow-Origin")
			if tc.wantAllow {
				require.Equal(t, tc.origin, allow)
			} else {
				require.Empty(t, allow)
			}
		})
	}
}
