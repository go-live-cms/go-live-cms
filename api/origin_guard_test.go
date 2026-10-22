package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// CORS origins and the cookie-route origin guard (#139).

const adminOrigin = "https://admin.example.com"

// newOriginTestServer builds a server with the given CORS_ALLOWED_ORIGINS
// ("" is the same-origin deployment: no CORS middleware at all).
func newOriginTestServer(t *testing.T, corsOrigins string) *Server {
	t.Helper()
	gin.SetMode(gin.TestMode)
	config := newTestConfig(t)
	config.CORSAllowedOrigins = corsOrigins
	config.TrustedProxies = "10.0.0.0/8"
	server, err := NewServer(config, nil)
	require.NoError(t, err)
	return server
}

func TestCORSOnlyForConfiguredOrigins(t *testing.T) {
	server := newOriginTestServer(t, adminOrigin)

	testCases := []struct {
		name    string
		origin  string
		allowed bool
	}{
		{"admin origin", adminOrigin, true},
		{"other origin", "https://evil.example", false},
		{"lookalike subdomain", "https://admin.example.com.evil.example", false},
		{"scheme downgrade", "http://admin.example.com", false},
		{"null origin", "null", false},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodOptions, "/api/v1/auth/refresh", nil)
			request.Header.Set("Origin", tc.origin)
			request.Header.Set("Access-Control-Request-Method", http.MethodPost)
			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, request)

			if tc.allowed {
				require.Equal(t, tc.origin, recorder.Header().Get("Access-Control-Allow-Origin"))
				require.Equal(t, "true", recorder.Header().Get("Access-Control-Allow-Credentials"))
			} else {
				require.Empty(t, recorder.Header().Get("Access-Control-Allow-Origin"))
				require.Empty(t, recorder.Header().Get("Access-Control-Allow-Credentials"))
			}
		})
	}
}

func TestInvalidCORSOriginsRefuseToStart(t *testing.T) {
	for _, origins := range []string{
		"*",
		"https://*.example.com",
		"admin.example.com",
		"ftp://admin.example.com",
		"https://admin.example.com/",
		"https://admin.example.com/gl-admin",
		"https://user@admin.example.com",
		adminOrigin + ",*",
	} {
		t.Run(origins, func(t *testing.T) {
			config := newTestConfig(t)
			config.CORSAllowedOrigins = origins
			_, err := NewServer(config, nil)
			require.ErrorContains(t, err, "CORS_ALLOWED_ORIGINS")
		})
	}
}

// The guard matters most in the same-origin deployment (no CORS_ALLOWED_ORIGINS),
// where no CORS middleware runs. With origins configured, gin-contrib/cors
// already answers 403 to any request whose Origin is not listed.
func TestCookieRoutesRefuseCrossOriginRequests(t *testing.T) {
	sameOrigin := newOriginTestServer(t, "")
	withCORS := newOriginTestServer(t, adminOrigin)

	testCases := []struct {
		name       string
		path       string
		headers    map[string]string
		host       string
		remoteAddr string
		refused    bool
		cors       bool // use the server with CORS_ALLOWED_ORIGINS=adminOrigin
	}{
		{name: "no browser headers", path: "/api/v1/auth/refresh"},
		{name: "same-origin fetch", path: "/api/v1/auth/refresh",
			headers: map[string]string{"Sec-Fetch-Site": "same-origin", "Origin": "https://site.example"}},
		{name: "cross-site from admin origin", path: "/api/v1/auth/refresh", cors: true,
			headers: map[string]string{"Sec-Fetch-Site": "cross-site", "Origin": adminOrigin}},
		{name: "cross-site from other origin", path: "/api/v1/auth/refresh", refused: true,
			headers: map[string]string{"Sec-Fetch-Site": "cross-site", "Origin": "https://evil.example"}},
		{name: "same-site sibling", path: "/api/v1/auth/refresh", refused: true,
			headers: map[string]string{"Sec-Fetch-Site": "same-site", "Origin": "https://blog.example.com"}},
		{name: "cross-site without origin", path: "/api/v1/auth/refresh", refused: true,
			headers: map[string]string{"Sec-Fetch-Site": "cross-site"}},
		{name: "old browser, origin matches host", path: "/api/v1/auth/refresh", host: "site.example",
			headers: map[string]string{"Origin": "https://site.example"}},
		{name: "old browser, other origin", path: "/api/v1/auth/refresh", host: "site.example", refused: true,
			headers: map[string]string{"Origin": "https://evil.example"}},
		{name: "old browser via trusted proxy", path: "/api/v1/auth/refresh", host: "api:8080", remoteAddr: "10.1.2.3:4000",
			headers: map[string]string{"Origin": "https://site.example", "X-Forwarded-Host": "site.example"}},
		{name: "forwarded host from untrusted peer", path: "/api/v1/auth/refresh", host: "api:8080", remoteAddr: "203.0.113.9:4000", refused: true,
			headers: map[string]string{"Origin": "https://site.example", "X-Forwarded-Host": "site.example"}},
		{name: "login cross-site", path: "/api/v1/auth/login", refused: true,
			headers: map[string]string{"Sec-Fetch-Site": "cross-site", "Origin": "https://evil.example"}},
		{name: "logout cross-site", path: "/api/v1/auth/logout", refused: true,
			headers: map[string]string{"Sec-Fetch-Site": "cross-site", "Origin": "https://evil.example"}},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, tc.path, nil)
			if tc.host != "" {
				request.Host = tc.host
			}
			if tc.remoteAddr != "" {
				request.RemoteAddr = tc.remoteAddr
			}
			for k, v := range tc.headers {
				request.Header.Set(k, v)
			}
			server := sameOrigin
			if tc.cors {
				server = withCORS
			}
			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, request)

			if tc.refused {
				require.Equal(t, http.StatusForbidden, recorder.Code, recorder.Body.String())
				require.Contains(t, recorder.Body.String(), "cross-origin request refused")
			} else {
				// Past the guard: refresh without a cookie is a 400.
				require.NotEqual(t, http.StatusForbidden, recorder.Code, recorder.Body.String())
			}
		})
	}
}
