package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	"github.com/go-live-cms/go-live-cms/util"
)

// findRefreshCookie returns the refresh cookie the response set, or fails.
func findRefreshCookie(t *testing.T, recorder *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()
	for _, c := range recorder.Result().Cookies() {
		if c.Name == RefreshCookieName {
			return c
		}
	}
	require.FailNow(t, "no refresh cookie in response")
	return nil
}

// TestLoginRefreshCookieSecure logs in through the real handler: the refresh
// cookie is Secure unless GIN_MODE=debug, and COOKIE_SECURE only matters there.
func TestLoginRefreshCookieSecure(t *testing.T) {
	user := randomUserForSessions()
	password := "testPassword123"
	hashedPassword, err := util.HashPassword(password)
	require.NoError(t, err)
	user.HashedPassword = hashedPassword

	// The real defaults, with no app.env and no environment overrides. A
	// leftover IS_DEVELOPMENT=true (the old switch) must not relax anything.
	t.Setenv("GIN_MODE", "")
	t.Setenv("COOKIE_SECURE", "")
	t.Setenv("IS_DEVELOPMENT", "true")
	defaults, err := util.LoadConfig(t.TempDir())
	require.NoError(t, err)

	testCases := []struct {
		name         string
		ginMode      string
		cookieSecure bool
		wantSecure   bool
	}{
		{name: "LoadConfig defaults", ginMode: defaults.GinMode, cookieSecure: defaults.CookieSecure, wantSecure: true},
		{name: "release", ginMode: util.GinModeRelease, wantSecure: true},
		{name: "test mode is not development", ginMode: util.GinModeTest, wantSecure: true},
		{name: "unset mode is not development", ginMode: "", wantSecure: true},
		{name: "debug, COOKIE_SECURE=false", ginMode: util.GinModeDebug, cookieSecure: false, wantSecure: false},
		{name: "debug, COOKIE_SECURE=true", ginMode: util.GinModeDebug, cookieSecure: true, wantSecure: true},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			store.EXPECT().GetUserByUsername(gomock.Any(), gomock.Eq(user.Username)).Times(1).Return(user, nil)
			store.EXPECT().CreateSession(gomock.Any(), gomock.Any()).Times(1).Return(randomSession(user), nil)

			gin.SetMode(gin.TestMode)
			config := newTestConfig(t)
			config.GinMode = tc.ginMode
			config.CookieSecure = tc.cookieSecure
			server, err := NewServer(config, store)
			require.NoError(t, err)

			data, err := json.Marshal(gin.H{"username": user.Username, "password": password})
			require.NoError(t, err)
			request, err := http.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewReader(data))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")

			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, request)
			require.Equal(t, http.StatusOK, recorder.Code)

			cookie := findRefreshCookie(t, recorder)
			require.NotEmpty(t, cookie.Value)
			require.Equal(t, tc.wantSecure, cookie.Secure)
			require.True(t, cookie.HttpOnly)
			require.Equal(t, http.SameSiteStrictMode, cookie.SameSite)
			require.Equal(t, CookiePath, cookie.Path)
		})
	}
}

// TestCookieSecurityHelpers covers setSecureCookie and clearSecureCookie
// directly: the clearing cookie must carry the same Secure/Domain as the one
// it replaces, in every mode.
func TestCookieSecurityHelpers(t *testing.T) {
	testCases := []struct {
		name         string
		ginMode      string
		cookieSecure bool
		domain       string
		wantSecure   bool
		wantDomain   string
	}{
		{name: "release default", ginMode: util.GinModeRelease, wantSecure: true},
		{name: "release keeps localhost domain", ginMode: util.GinModeRelease, domain: "localhost", wantSecure: true, wantDomain: "localhost"},
		{name: "release with domain", ginMode: util.GinModeRelease, domain: "example.com", wantSecure: true, wantDomain: "example.com"},
		{name: "debug insecure", ginMode: util.GinModeDebug, wantSecure: false},
		{name: "debug secure", ginMode: util.GinModeDebug, cookieSecure: true, wantSecure: true},
		{name: "debug drops localhost domain", ginMode: util.GinModeDebug, domain: "localhost", wantSecure: false},
		{name: "debug with domain", ginMode: util.GinModeDebug, domain: "dev.example.com", wantSecure: false, wantDomain: "dev.example.com"},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			server := &Server{config: util.Config{
				GinMode:      tc.ginMode,
				CookieSecure: tc.cookieSecure,
				CookieDomain: tc.domain,
			}}

			for _, op := range []struct {
				name string
				run  func(ctx *gin.Context)
			}{
				{name: "set", run: func(ctx *gin.Context) {
					server.setSecureCookie(ctx, RefreshCookieName, "token", time.Now().Add(time.Hour))
				}},
				{name: "clear", run: func(ctx *gin.Context) {
					server.clearSecureCookie(ctx, RefreshCookieName)
				}},
			} {
				recorder := httptest.NewRecorder()
				ctx, _ := gin.CreateTestContext(recorder)
				op.run(ctx)

				cookie := findRefreshCookie(t, recorder)
				require.Equal(t, tc.wantSecure, cookie.Secure, op.name)
				require.Equal(t, tc.wantDomain, cookie.Domain, op.name)
				require.True(t, cookie.HttpOnly, op.name)
			}
		})
	}
}
