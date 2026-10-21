package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	"github.com/go-live-cms/go-live-cms/util"
)

// requireBaselineSecurityHeaders checks the headers every API response
// carries, and HSTS only when wantHSTS.
func requireBaselineSecurityHeaders(t *testing.T, header http.Header, wantHSTS bool) {
	t.Helper()
	require.Equal(t, "nosniff", header.Get("X-Content-Type-Options"))
	require.Equal(t, "DENY", header.Get("X-Frame-Options"))
	require.Equal(t, "no-referrer", header.Get("Referrer-Policy"))
	require.Equal(t, apiContentSecurityPolicy, header.Get("Content-Security-Policy"))
	if wantHSTS {
		require.Equal(t, hstsHeaderValue, header.Get("Strict-Transport-Security"))
	} else {
		require.Empty(t, header.Values("Strict-Transport-Security"))
	}
	// Would block the public site and admin loading /uploads cross-origin.
	require.Empty(t, header.Values("Cross-Origin-Resource-Policy"))
}

// TestSecurityHeaders runs requests through the real router: JSON routes,
// 404s, static /uploads media and CORS preflights all get the baseline
// headers. HSTS is sent in every mode except debug.
func TestSecurityHeaders(t *testing.T) {
	pngBytes := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")

	testCases := []struct {
		name     string
		ginMode  string
		wantHSTS bool
	}{
		{name: "release", ginMode: util.GinModeRelease, wantHSTS: true},
		{name: "unset mode", ginMode: "", wantHSTS: true},
		{name: "test mode", ginMode: util.GinModeTest, wantHSTS: true},
		{name: "debug", ginMode: util.GinModeDebug, wantHSTS: false},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)

			config := newTestConfig(t)
			config.GinMode = tc.ginMode
			config.CORSAllowedOrigins = "https://cms.example.com"
			require.NoError(t, os.WriteFile(filepath.Join(config.UploadPath, "pic.png"), pngBytes, 0o644))
			server, err := NewServer(config, store)
			require.NoError(t, err)

			serve := func(request *http.Request) *httptest.ResponseRecorder {
				recorder := httptest.NewRecorder()
				server.router.ServeHTTP(recorder, request)
				return recorder
			}

			t.Run("json", func(t *testing.T) {
				recorder := serve(httptest.NewRequest(http.MethodGet, "/health", nil))
				require.Equal(t, http.StatusOK, recorder.Code)
				requireBaselineSecurityHeaders(t, recorder.Header(), tc.wantHSTS)
			})

			t.Run("not found", func(t *testing.T) {
				recorder := serve(httptest.NewRequest(http.MethodGet, "/api/v1/does-not-exist", nil))
				require.Equal(t, http.StatusNotFound, recorder.Code)
				requireBaselineSecurityHeaders(t, recorder.Header(), tc.wantHSTS)
			})

			t.Run("uploads still served", func(t *testing.T) {
				request := httptest.NewRequest(http.MethodGet, "/uploads/media/pic.png", nil)
				request.Header.Set("Origin", "https://cms.example.com")
				recorder := serve(request)
				require.Equal(t, http.StatusOK, recorder.Code)
				require.Equal(t, "image/png", recorder.Header().Get("Content-Type"))
				require.Equal(t, pngBytes, recorder.Body.Bytes())
				require.Equal(t, "https://cms.example.com", recorder.Header().Get("Access-Control-Allow-Origin"))
				requireBaselineSecurityHeaders(t, recorder.Header(), tc.wantHSTS)
			})

			t.Run("cors preflight", func(t *testing.T) {
				request := httptest.NewRequest(http.MethodOptions, "/api/v1/posts", nil)
				request.Header.Set("Origin", "https://cms.example.com")
				request.Header.Set("Access-Control-Request-Method", http.MethodPut)
				request.Header.Set("Access-Control-Request-Headers", "Authorization, Content-Type")
				recorder := serve(request)
				require.Equal(t, http.StatusNoContent, recorder.Code)
				require.Equal(t, "https://cms.example.com", recorder.Header().Get("Access-Control-Allow-Origin"))
				require.Equal(t, "true", recorder.Header().Get("Access-Control-Allow-Credentials"))
				requireBaselineSecurityHeaders(t, recorder.Header(), tc.wantHSTS)
			})
		})
	}
}
