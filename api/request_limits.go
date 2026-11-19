package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// Request body size limits (#139).
//
// Every /api/v1 and /public request body is capped at defaultBodyLimit,
// except the routes in bodyLimitOverrides. Reading past the cap fails, and
// bindJSON answers 413. Multipart upload routes are exempt here (limit 0)
// because they cap their own body from MAX_UPLOAD_SIZE (limitUploadBody):
// a smaller outer cap would wrap theirs and win.
const (
	// defaultBodyLimit fits any JSON request except a block document.
	defaultBodyLimit int64 = 1 << 20 // 1 MiB

	// blockDocBodyLimit is for POST /posts with a block_doc. Images are references
	// (mediaId/src; the editor disables data: URLs), so real documents are a
	// few hundred KB at most.
	blockDocBodyLimit int64 = 4 << 20 // 4 MiB

	// discussionBodyLimit is for the public comment writes (#524), the API's anonymous
	// writes outside /auth. The design's 16 KiB is too tight: 4000 characters of text
	// can be 16,000 bytes of UTF-8 (emoji), before the name, address and JSON.
	discussionBodyLimit int64 = 24 << 10 // 24 KiB
)

// bodyLimitOverrides maps "METHOD route-template" to its body limit; 0 means
// the handler sets its own.
var bodyLimitOverrides = map[string]int64{
	"POST /api/v1/posts":             blockDocBodyLimit, // may carry the initial block_doc (#283)
	"POST /api/v1/media":             0,
	"POST /api/v1/media/batch":       0,
	"POST /api/v1/media/bulk":        0,
	"POST /api/v1/media/:id/replace": 0,
	"PUT /api/v1/users/me/avatar":    0, // avatarMaxBytes (#334)
	"POST /api/v1/imports":           0, // IMPORT_MAX_SIZE (#150)
	// Reader comments' anonymous writes (#524).
	"POST /public/posts/:id/comments":         discussionBodyLimit,
	"POST /public/discussion/confirm":         discussionBodyLimit,
	"POST /public/discussion/unconfirmed/:id": discussionBodyLimit,
}

// bodyLimitMiddleware caps the request body for the matched route. It runs as
// group middleware, after routing, so c.FullPath() is the route template.
func bodyLimitMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		limit := defaultBodyLimit
		if override, ok := bodyLimitOverrides[c.Request.Method+" "+c.FullPath()]; ok {
			limit = override
		}
		if limit > 0 && c.Request.Body != nil {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
		}
		c.Next()
	}
}
