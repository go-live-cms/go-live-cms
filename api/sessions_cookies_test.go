package api

import (
	"bytes"
	"encoding/json"
	"fmt"
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

// findCookie returns the cookie named name that the response set, or nil.
func findCookie(recorder *httptest.ResponseRecorder, name string) *http.Cookie {
	for _, c := range recorder.Result().Cookies() {
		if c.Name == name {
			return c
		}
	}
	return nil
}

// findRefreshCookie returns the refresh cookie named name that the response
// set, or fails.
func findRefreshCookie(t *testing.T, recorder *httptest.ResponseRecorder, name string) *http.Cookie {
	t.Helper()
	cookie := findCookie(recorder, name)
	require.NotNil(t, cookie, "no %s cookie in response", name)
	return cookie
}

// requireLegacyCookieCleared checks that the response expires the pre-#159
// refresh_token cookie (Path=/api/v1/auth) with the given Domain.
func requireLegacyCookieCleared(t *testing.T, recorder *httptest.ResponseRecorder, wantDomain string) {
	t.Helper()
	legacy := findRefreshCookie(t, recorder, RefreshCookieName)
	require.Empty(t, legacy.Value)
	require.Equal(t, -1, legacy.MaxAge)
	require.Equal(t, CookiePath, legacy.Path)
	require.Equal(t, wantDomain, legacy.Domain)
	require.True(t, legacy.Secure)
}

// TestLoginRefreshCookieSecure logs in through the real handler: the refresh
// cookie is Secure unless GIN_MODE=debug, and COOKIE_SECURE only matters there.
// A Secure cookie is __Host-refresh_token with Path=/ and no Domain (#159).
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
		domain       string
		wantSecure   bool
	}{
		{name: "LoadConfig defaults", ginMode: defaults.GinMode, cookieSecure: defaults.CookieSecure, domain: defaults.CookieDomain, wantSecure: true},
		{name: "release", ginMode: util.GinModeRelease, wantSecure: true},
		{name: "release ignores COOKIE_DOMAIN", ginMode: util.GinModeRelease, domain: "example.com", wantSecure: true},
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
			config.CookieDomain = tc.domain
			server, err := NewServer(config, store)
			require.NoError(t, err)

			data, err := json.Marshal(gin.H{"username": user.Username, "password": password})
			require.NoError(t, err)
			request, err := http.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewReader(data))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")
			// The browser still holds a pre-#159 cookie (or, in debug, the
			// current non-Secure one).
			request.AddCookie(&http.Cookie{Name: RefreshCookieName, Value: "old-token"})

			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, request)
			require.Equal(t, http.StatusOK, recorder.Code)

			if tc.wantSecure {
				cookie := findRefreshCookie(t, recorder, HostRefreshCookieName)
				require.NotEmpty(t, cookie.Value)
				require.True(t, cookie.Secure)
				require.Equal(t, "/", cookie.Path)
				require.Empty(t, cookie.Domain)
				require.True(t, cookie.HttpOnly)
				require.Equal(t, http.SameSiteStrictMode, cookie.SameSite)
				requireLegacyCookieCleared(t, recorder, tc.domain)
				return
			}

			cookie := findRefreshCookie(t, recorder, RefreshCookieName)
			require.NotEmpty(t, cookie.Value)
			require.False(t, cookie.Secure)
			require.Equal(t, CookiePath, cookie.Path)
			require.True(t, cookie.HttpOnly)
			require.Equal(t, http.SameSiteStrictMode, cookie.SameSite)
			require.Nil(t, findCookie(recorder, HostRefreshCookieName))
		})
	}
}

// TestRefreshCookieHelpers covers setRefreshCookie and clearRefreshCookie
// directly: the name and attributes per mode, and the clearing cookie
// carrying the same name/Path/Secure/Domain as the one it replaces.
func TestRefreshCookieHelpers(t *testing.T) {
	testCases := []struct {
		name         string
		ginMode      string
		cookieSecure bool
		domain       string
		wantName     string
		wantPath     string
		wantSecure   bool
		wantDomain   string
		// wantLegacyDomain is the Domain of the legacy refresh_token clear;
		// nil means no legacy clear is sent.
		wantLegacyDomain *string
	}{
		{name: "release default", ginMode: util.GinModeRelease, wantName: HostRefreshCookieName, wantPath: "/", wantSecure: true, wantLegacyDomain: strPtr("")},
		{name: "release drops localhost domain", ginMode: util.GinModeRelease, domain: "localhost", wantName: HostRefreshCookieName, wantPath: "/", wantSecure: true, wantLegacyDomain: strPtr("localhost")},
		{name: "release drops domain", ginMode: util.GinModeRelease, domain: "example.com", wantName: HostRefreshCookieName, wantPath: "/", wantSecure: true, wantLegacyDomain: strPtr("example.com")},
		{name: "debug insecure", ginMode: util.GinModeDebug, wantName: RefreshCookieName, wantPath: CookiePath, wantSecure: false},
		{name: "debug secure", ginMode: util.GinModeDebug, cookieSecure: true, wantName: HostRefreshCookieName, wantPath: "/", wantSecure: true, wantLegacyDomain: strPtr("")},
		{name: "debug secure, localhost domain", ginMode: util.GinModeDebug, cookieSecure: true, domain: "localhost", wantName: HostRefreshCookieName, wantPath: "/", wantSecure: true, wantLegacyDomain: strPtr("")},
		{name: "debug drops localhost domain", ginMode: util.GinModeDebug, domain: "localhost", wantName: RefreshCookieName, wantPath: CookiePath, wantSecure: false},
		{name: "debug with domain", ginMode: util.GinModeDebug, domain: "dev.example.com", wantName: RefreshCookieName, wantPath: CookiePath, wantSecure: false, wantDomain: "dev.example.com"},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			server := &Server{config: util.Config{
				GinMode:      tc.ginMode,
				CookieSecure: tc.cookieSecure,
				CookieDomain: tc.domain,
			}}
			require.Equal(t, tc.wantName, server.refreshCookieName())

			for _, op := range []struct {
				name string
				run  func(ctx *gin.Context)
			}{
				{name: "set", run: func(ctx *gin.Context) {
					server.setRefreshCookie(ctx, "token", time.Now().Add(time.Hour))
				}},
				{name: "clear", run: func(ctx *gin.Context) {
					server.clearRefreshCookie(ctx)
				}},
			} {
				for _, sendsLegacy := range []bool{false, true} {
					name := fmt.Sprintf("%s, request has refresh_token=%v", op.name, sendsLegacy)
					recorder := httptest.NewRecorder()
					ctx, _ := gin.CreateTestContext(recorder)
					ctx.Request = httptest.NewRequest(http.MethodPost, "/api/v1/auth/refresh", nil)
					if sendsLegacy {
						ctx.Request.AddCookie(&http.Cookie{Name: RefreshCookieName, Value: "old-token"})
					}
					op.run(ctx)

					cookie := findRefreshCookie(t, recorder, tc.wantName)
					require.Equal(t, tc.wantSecure, cookie.Secure, name)
					require.Equal(t, tc.wantPath, cookie.Path, name)
					require.Equal(t, tc.wantDomain, cookie.Domain, name)
					require.True(t, cookie.HttpOnly, name)
					require.Equal(t, http.SameSiteStrictMode, cookie.SameSite, name)
					if op.name == "clear" {
						require.Equal(t, -1, cookie.MaxAge, name)
					}

					// The legacy clear is only sent with the __Host- cookie,
					// and only when the request carries a legacy cookie.
					if tc.wantLegacyDomain != nil && sendsLegacy {
						requireLegacyCookieCleared(t, recorder, *tc.wantLegacyDomain)
					} else {
						require.Len(t, recorder.Result().Cookies(), 1, name)
					}
				}
			}
		})
	}
}

// TestRefreshCookieNameOnRead checks that refresh and logout read only the
// current cookie name: with the __Host- cookie in use, a legacy (or planted)
// refresh_token cookie is ignored, and in plain-HTTP debug mode the
// __Host- name is ignored. Neither request reaches the store.
func TestRefreshCookieNameOnRead(t *testing.T) {
	testCases := []struct {
		name         string
		ginMode      string
		cookieSecure bool
		ignoredName  string
	}{
		{name: "release ignores refresh_token", ginMode: util.GinModeRelease, ignoredName: RefreshCookieName},
		{name: "debug insecure ignores __Host-", ginMode: util.GinModeDebug, ignoredName: HostRefreshCookieName},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl) // no expectations: any store call fails

			config := newTestConfig(t)
			config.GinMode = tc.ginMode
			config.CookieSecure = tc.cookieSecure
			server, err := NewServer(config, store)
			require.NoError(t, err)

			request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/refresh", nil)
			request.AddCookie(&http.Cookie{Name: tc.ignoredName, Value: "some-token"})
			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, request)
			require.Equal(t, http.StatusBadRequest, recorder.Code)

			// The logout route requires an access token; call the handler
			// directly, since only its cookie handling is under test.
			recorder = httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(recorder)
			ctx.Request = httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
			ctx.Request.AddCookie(&http.Cookie{Name: tc.ignoredName, Value: "some-token"})
			server.logoutUser(ctx)
			require.Equal(t, http.StatusOK, recorder.Code)
			cleared := findRefreshCookie(t, recorder, server.refreshCookieName())
			require.Equal(t, -1, cleared.MaxAge)
		})
	}
}

// TestIgnoredCookieDomainWarning: COOKIE_DOMAIN warns only when the
// __Host- cookie is in use and the domain would have had an effect.
func TestIgnoredCookieDomainWarning(t *testing.T) {
	testCases := []struct {
		name         string
		ginMode      string
		cookieSecure bool
		domain       string
		wantWarning  bool
	}{
		{name: "release, no domain", ginMode: util.GinModeRelease},
		{name: "release, localhost", ginMode: util.GinModeRelease, domain: "localhost"},
		{name: "release, real domain", ginMode: util.GinModeRelease, domain: "example.com", wantWarning: true},
		{name: "debug secure, real domain", ginMode: util.GinModeDebug, cookieSecure: true, domain: "example.com", wantWarning: true},
		{name: "debug insecure uses the domain", ginMode: util.GinModeDebug, domain: "dev.example.com"},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			server := &Server{config: util.Config{
				GinMode:      tc.ginMode,
				CookieSecure: tc.cookieSecure,
				CookieDomain: tc.domain,
			}}
			warning := server.ignoredCookieDomainWarning()
			if tc.wantWarning {
				require.Contains(t, warning, tc.domain)
				require.Contains(t, warning, HostRefreshCookieName)
			} else {
				require.Empty(t, warning)
			}
		})
	}
}

func strPtr(s string) *string { return &s }
