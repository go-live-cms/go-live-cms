// sessions_cookies provides secure cookie utilities for authentication token management.
//
// # Cookie Security Strategy
//
// This module implements defense-in-depth cookie security:
//   - **httpOnly**: Prevents JavaScript access, mitigating XSS token theft
//   - **SameSite=Strict**: Blocks cross-site requests, preventing CSRF attacks
//   - **Secure**: Requires HTTPS in production, ensuring encrypted transport
//   - **Path restriction**: Limits scope to /api/v1/auth, reducing exposure surface
//   - **Domain configuration**: Supports development and production domain settings
//
// # Development vs Production
//
// Cookie behavior adapts to environment:
//   - **Development**: Flexible security for local HTTP testing
//   - **Production**: Enforced HTTPS and strict security settings
//   - **Domain handling**: localhost exemptions for local development
//
// # Constants and Configuration
//
// Centralized cookie configuration prevents magic string errors:
//   - RefreshCookieName for consistent cookie identification
//   - CookiePath for proper scope restriction
//   - Environment-specific security flag handling
package api

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	// RefreshCookieName is the standardized name for refresh token cookies
	RefreshCookieName = "refresh_token"

	// CookiePath restricts refresh cookies to authentication endpoints only
	CookiePath = "/api/v1/auth"
)

// setSecureCookie creates and sets an httpOnly, secure cookie with environment-appropriate settings.
//
// Security features:
//   - httpOnly prevents JavaScript access
//   - SameSite=Strict blocks cross-site requests
//   - Secure flag enforced in production
//   - Path restriction limits cookie scope
//   - Domain configuration supports dev/prod environments
//
// Parameters:
//   - ctx: Gin context for response writing
//   - name: Cookie name (typically RefreshCookieName)
//   - value: Cookie value (typically encrypted refresh token)
//   - expiration: Cookie expiration time
func (server *Server) setSecureCookie(ctx *gin.Context, name, value string, expiration time.Time) {
	cookie := &http.Cookie{
		Name:     name,
		Value:    value,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Path:     CookiePath,
		Expires:  expiration,
	}

	// Environment-specific security configuration
	if server.config.IsDevelopment {
		cookie.Secure = server.config.CookieSecure
		if server.config.CookieDomain != "localhost" && server.config.CookieDomain != "" {
			cookie.Domain = server.config.CookieDomain
		}
	} else {
		cookie.Secure = true
		if server.config.CookieDomain != "" {
			cookie.Domain = server.config.CookieDomain
		}
	}

	http.SetCookie(ctx.Writer, cookie)
}

// clearSecureCookie removes a cookie by setting it to expire immediately.
//
// Cookie clearing strategy:
//   - Sets MaxAge=-1 for immediate expiration
//   - Maintains same path/domain as original cookie
//   - Uses empty value to clear content
//   - Preserves security flags for consistency
//
// Parameters:
//   - ctx: Gin context for response writing
//   - name: Cookie name to clear (typically RefreshCookieName)
func (server *Server) clearSecureCookie(ctx *gin.Context, name string) {
	cookie := &http.Cookie{
		Name:     name,
		Value:    "",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Path:     CookiePath,
		MaxAge:   -1,
	}

	// Mirror security settings from setSecureCookie for consistency
	if server.config.IsDevelopment {
		cookie.Secure = server.config.CookieSecure
		if server.config.CookieDomain != "localhost" && server.config.CookieDomain != "" {
			cookie.Domain = server.config.CookieDomain
		}
	} else {
		cookie.Secure = true
		if server.config.CookieDomain != "" {
			cookie.Domain = server.config.CookieDomain
		}
	}

	http.SetCookie(ctx.Writer, cookie)
}
