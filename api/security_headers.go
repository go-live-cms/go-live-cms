package api

import (
	"github.com/gin-gonic/gin"
	"github.com/go-live-cms/go-live-cms/util"
)

const (
	// apiContentSecurityPolicy allows nothing: API responses are JSON or
	// uploaded media, never documents that load subresources. Browsers apply it
	// only when a response is opened as a document (e.g. an uploaded SVG opened
	// directly), so it doesn't affect <img>/<video> embeds of /uploads.
	apiContentSecurityPolicy = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

	// hstsHeaderValue is one year. Browsers ignore HSTS received over plain
	// HTTP, so it only takes effect once the API is served over HTTPS.
	hstsHeaderValue = "max-age=31536000; includeSubDomains"
)

// securityHeadersMiddleware sets baseline security headers on every response,
// including CORS preflights, 404s and static /uploads files.
//
// Strict-Transport-Security is sent outside debug mode only (GIN_MODE=debug is
// development, served over plain HTTP).
//
// No Cross-Origin-Resource-Policy header: the public site and admin load
// /uploads media cross-origin, and same-origin/same-site CORP would block it.
func securityHeadersMiddleware(config util.Config) gin.HandlerFunc {
	sendHSTS := !config.IsDebugMode()

	return func(c *gin.Context) {
		h := c.Writer.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Content-Security-Policy", apiContentSecurityPolicy)
		if sendHSTS {
			h.Set("Strict-Transport-Security", hstsHeaderValue)
		}
		c.Next()
	}
}
