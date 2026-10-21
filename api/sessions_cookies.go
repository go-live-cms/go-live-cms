// sessions_cookies provides secure cookie utilities for authentication token management.
//
// # Cookie Security Strategy
//
// This module implements defense-in-depth cookie security:
//   - **httpOnly**: Prevents JavaScript access, mitigating XSS token theft
//   - **SameSite=Strict**: Blocks cross-site requests, preventing CSRF attacks
//   - **Secure**: Requires HTTPS in production, ensuring encrypted transport
//   - **__Host- prefix**: Whenever the cookie is Secure, it is named
//     __Host-refresh_token. Browsers only accept that name with Secure, Path=/
//     and no Domain, so a sibling subdomain or a plain-HTTP response can't
//     plant or shadow it (#159)
//
// # Development vs Production
//
// Cookie behavior adapts to environment:
//   - **Production** (every mode except GIN_MODE=debug, including the release
//     default): Secure is always set, so the cookie is
//     __Host-refresh_token, host-only, Path=/. COOKIE_DOMAIN is ignored.
//   - **Development** (GIN_MODE=debug): Secure follows COOKIE_SECURE. With
//     COOKIE_SECURE=false (compose.dev.yaml) the cookie can't use the prefix, so
//     it keeps the plain refresh_token name, Path=/api/v1/auth, and
//     COOKIE_DOMAIN (except "localhost", which is dropped). With
//     COOKIE_SECURE=true it is __Host-refresh_token, like production.
//
// # Legacy cookie
//
// Before #159 production set refresh_token (Path=/api/v1/auth, Domain from
// COOKIE_DOMAIN). It is never read when the __Host- cookie is in use; login,
// refresh and logout expire it so it doesn't linger in browsers.
package api

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	// RefreshCookieName is the refresh cookie's name when it is not Secure
	// (plain-HTTP development), and the pre-#159 production name.
	RefreshCookieName = "refresh_token"

	// HostRefreshCookieName is the refresh cookie's name whenever it is Secure.
	HostRefreshCookieName = "__Host-" + RefreshCookieName

	// CookiePath restricts the non-Secure refresh cookie to authentication
	// endpoints. The __Host- cookie must use Path=/.
	CookiePath = "/api/v1/auth"

	// hostCookiePath is the only Path the __Host- prefix allows.
	hostCookiePath = "/"
)

// refreshCookieSecure reports whether the refresh cookie gets the Secure flag:
// always outside GIN_MODE=debug, otherwise COOKIE_SECURE decides. Development
// is the same switch that gates dev seeding and dev CORS (#236).
func (server *Server) refreshCookieSecure() bool {
	return !server.config.IsDebugMode() || server.config.CookieSecure
}

// refreshCookieName is the name the refresh cookie is set, read and cleared
// under: HostRefreshCookieName when Secure, RefreshCookieName otherwise.
func (server *Server) refreshCookieName() string {
	if server.refreshCookieSecure() {
		return HostRefreshCookieName
	}
	return RefreshCookieName
}

// newRefreshCookie returns the refresh cookie with every attribute except its
// value and lifetime. Set and clear both use it, so the clearing cookie always
// matches the one it replaces (same name, Path, Domain and Secure).
func (server *Server) newRefreshCookie() *http.Cookie {
	cookie := &http.Cookie{
		Name:     server.refreshCookieName(),
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	}

	if server.refreshCookieSecure() {
		// __Host- requirements: Secure, Path=/, no Domain.
		cookie.Secure = true
		cookie.Path = hostCookiePath
		return cookie
	}

	cookie.Path = CookiePath
	if server.config.CookieDomain != "localhost" && server.config.CookieDomain != "" {
		cookie.Domain = server.config.CookieDomain
	}
	return cookie
}

// setRefreshCookie sets the refresh cookie to value, expiring at expiration,
// and expires any pre-#159 legacy cookie.
func (server *Server) setRefreshCookie(ctx *gin.Context, value string, expiration time.Time) {
	cookie := server.newRefreshCookie()
	cookie.Value = value
	cookie.Expires = expiration
	http.SetCookie(ctx.Writer, cookie)

	server.clearLegacyRefreshCookie(ctx)
}

// clearRefreshCookie expires the refresh cookie (and any legacy one).
func (server *Server) clearRefreshCookie(ctx *gin.Context) {
	cookie := server.newRefreshCookie()
	cookie.MaxAge = -1
	http.SetCookie(ctx.Writer, cookie)

	server.clearLegacyRefreshCookie(ctx)
}

// readRefreshCookie returns the refresh token from the request's refresh
// cookie, or "" if there is none. A legacy refresh_token cookie is ignored
// when the __Host- cookie is in use.
func (server *Server) readRefreshCookie(ctx *gin.Context) string {
	cookie, err := ctx.Request.Cookie(server.refreshCookieName())
	if err != nil {
		return ""
	}
	return cookie.Value
}

// clearLegacyRefreshCookie expires the refresh_token cookie that production
// set before #159 (Secure, Path=/api/v1/auth, Domain from COOKIE_DOMAIN).
// Only needed when the current cookie is the __Host- one; otherwise the
// current cookie has the plain name and clearing it is enough.
func (server *Server) clearLegacyRefreshCookie(ctx *gin.Context) {
	if !server.refreshCookieSecure() {
		return
	}
	domain := server.config.CookieDomain
	if server.config.IsDebugMode() && domain == "localhost" {
		domain = "" // debug mode always dropped a localhost domain
	}
	http.SetCookie(ctx.Writer, &http.Cookie{
		Name:     RefreshCookieName,
		Path:     CookiePath,
		Domain:   domain,
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   -1,
	})
}
