package api

import (
	"net/http"
	"net/netip"
	"net/url"
	"strings"

	"github.com/gin-gonic/gin"
)

// CSRF defence for the cookie-authenticated endpoints (#139).
//
// /auth/refresh is authenticated by the refresh cookie alone, and /auth/login
// sets it (login CSRF would sign a victim into the attacker's account). Every
// other endpoint needs a Bearer token, which a cross-site page can't attach.
//
// The cookie is SameSite=Strict, and outside debug mode it is
// __Host-refresh_token (Secure, Path=/, no Domain), so a sibling subdomain
// can't plant or overwrite it. SameSite is per *site*, though, and some
// browsers or extensions don't honour it, so these routes also refuse
// requests a browser marks as coming from another origin:
//
//   - Sec-Fetch-Site same-origin or none (typed URL, bookmark): allowed.
//   - Sec-Fetch-Site same-site or cross-site: allowed only from an allowed
//     CORS origin (corsOrigins), else 403.
//   - No Sec-Fetch-Site (older browsers, non-browser clients): an Origin
//     header, if present, must be an allowed CORS origin or match the host
//     the request was sent to (Host, or X-Forwarded-Host from a trusted
//     proxy, which the web container's /api proxy sets). No Origin passes:
//     browsers send one on every cross-origin POST.
//
// /auth/logout also takes a Bearer token, but it is guarded too because it
// clears the cookie.

// originGuard returns the middleware described above.
func originGuard(allowedOrigins []string, trustedProxies []netip.Prefix) gin.HandlerFunc {
	allowed := make(map[string]bool, len(allowedOrigins))
	for _, o := range allowedOrigins {
		allowed[strings.ToLower(o)] = true
	}

	return func(c *gin.Context) {
		origin := strings.ToLower(c.GetHeader("Origin"))
		if allowed[origin] {
			c.Next()
			return
		}

		switch c.GetHeader("Sec-Fetch-Site") {
		case "same-origin", "none":
			c.Next()
			return
		case "":
			if origin == "" || originMatchesHost(c, origin, trustedProxies) {
				c.Next()
				return
			}
		}

		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "cross-origin request refused"})
	}
}

// originMatchesHost reports whether origin's host is the host the client
// addressed: the Host header, or X-Forwarded-Host when the peer is a
// trusted proxy.
func originMatchesHost(c *gin.Context, origin string, trustedProxies []netip.Prefix) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	if strings.EqualFold(u.Host, c.Request.Host) {
		return true
	}
	forwarded := strings.TrimSpace(strings.Split(c.GetHeader("X-Forwarded-Host"), ",")[0])
	if forwarded == "" || !strings.EqualFold(u.Host, forwarded) {
		return false
	}
	peer, err := netip.ParseAddr(c.RemoteIP())
	if err != nil {
		return false
	}
	peer = peer.Unmap()
	for _, p := range trustedProxies {
		if p.Contains(peer) {
			return true
		}
	}
	return false
}
