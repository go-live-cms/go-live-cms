package api

// Redirects (#331, #146, 000047, db/sqlc/redirects_tx.go).
//
// One row per old site path. The API adds automatic ones when a public URL changes (a
// published post's slug, a public term's slug, a tag merge) and admins add and delete
// manual ones in Settings › URLs & redirects. The public site asks GET
// /public/redirects?path= only for a request it would answer 404 (the web's
// middleware), so a redirect never hides a live page; the answer is a 301 or 302.
//
// Paths are stored decoded ("/tag/são-paulo"), without a query, fragment or trailing
// slash ("/" itself excepted); the lookup normalizes the request path the same way.

import (
	"database/sql"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/gin-gonic/gin"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// maxRedirectPath is the longest path or URL a redirect stores (the table's CHECK).
const maxRedirectPath = 2000

// reservedPathPrefixes are the first segments that aren't the public site's pages:
// the admin, the API and the files the web serves itself. Nothing redirects from them.
var reservedPathPrefixes = []string{"gl-admin", "api", "uploads", "themes", "_astro"}

func (server *Server) registerRedirectRoutes(v1 *gin.RouterGroup) {
	redirects := v1.Group("/redirects", server.requireAuth(), requireSiteAdmin(server))
	redirects.GET("", server.listRedirects)
	redirects.POST("", server.createRedirect)
	redirects.DELETE("/:id", server.deleteRedirect)
}

// CreateRedirectRequest is POST /redirects.
type CreateRedirectRequest struct {
	FromPath   string `json:"from_path" binding:"required,max=2000"`
	ToPath     string `json:"to_path" binding:"required,max=2000"`
	StatusCode int32  `json:"status_code" binding:"omitempty,oneof=301 302"`
}

// RedirectResponse is one redirect as the admin lists it.
type RedirectResponse struct {
	ID         int64  `json:"id"`
	FromPath   string `json:"from_path"`
	ToPath     string `json:"to_path"`
	StatusCode int32  `json:"status_code"`
	// Source: manual, or post / term / merge for the automatic ones.
	Source    string `json:"source"`
	External  bool   `json:"external"`
	CreatedAt string `json:"created_at"`
	// CreatedBy is who made it (public fields), null for the system or a member
	// removed since.
	CreatedBy *RedirectAuthor `json:"created_by"`
}

type RedirectAuthor struct {
	ID       int64   `json:"id"`
	Username string  `json:"username"`
	FullName string  `json:"full_name"`
	Avatar   *string `json:"avatar"`
}

func toRedirectResponse(r db.Redirect, author *RedirectAuthor) RedirectResponse {
	return RedirectResponse{
		ID:         r.ID,
		FromPath:   r.FromPath,
		ToPath:     r.ToPath,
		StatusCode: r.StatusCode,
		Source:     r.Source,
		External:   !strings.HasPrefix(r.ToPath, "/"),
		CreatedAt:  r.CreatedAt.UTC().Format(time.RFC3339),
		CreatedBy:  author,
	}
}

// normalizeSitePath turns a path as typed (or requested) into its stored form, or
// says why it isn't a site path. Percent-escapes are decoded; a query, fragment,
// whitespace or control character, "//" at the start or a backslash is refused.
func normalizeSitePath(raw string) (string, string) {
	p := strings.TrimSpace(raw)
	if p == "" || !strings.HasPrefix(p, "/") {
		return "", "must start with /"
	}
	if strings.HasPrefix(p, "//") {
		return "", "must be a path on this site"
	}
	if strings.ContainsAny(p, "?#") {
		return "", "can't have a query or fragment"
	}
	decoded, err := url.PathUnescape(p)
	if err != nil {
		return "", "has an invalid escape"
	}
	for _, r := range decoded {
		if unicode.IsSpace(r) || unicode.IsControl(r) || r == '\\' {
			return "", "can't contain spaces or control characters"
		}
	}
	for len(decoded) > 1 && strings.HasSuffix(decoded, "/") {
		decoded = strings.TrimSuffix(decoded, "/")
	}
	if strings.HasPrefix(decoded, "//") {
		return "", "must be a path on this site"
	}
	if len(decoded) > maxRedirectPath {
		return "", "is too long"
	}
	return decoded, ""
}

// isReservedSitePath: under the admin, the API or the web's own files.
func isReservedSitePath(p string) bool {
	first := strings.SplitN(strings.TrimPrefix(p, "/"), "/", 2)[0]
	for _, prefix := range reservedPathPrefixes {
		if strings.EqualFold(first, prefix) {
			return true
		}
	}
	return false
}

// normalizeRedirectTarget accepts a site path (normalized like a source) or an
// absolute http(s) URL with a host and no credentials.
func normalizeRedirectTarget(raw string) (string, string) {
	t := strings.TrimSpace(raw)
	if strings.HasPrefix(t, "/") {
		return normalizeSitePath(t)
	}
	u, err := url.Parse(t)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", "must be a path on this site (/…) or an http(s) URL"
	}
	if u.User != nil {
		return "", "can't contain credentials"
	}
	for _, r := range t {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return "", "can't contain spaces or control characters"
		}
	}
	if len(t) > maxRedirectPath {
		return "", "is too long"
	}
	return t, ""
}

func redirectFieldError(c *gin.Context, field, message string) {
	c.JSON(http.StatusBadRequest, gin.H{"error": field + " " + message, "fields": gin.H{field: message}})
}

// createRedirect handles POST /redirects (admins): a manual redirect.
func (server *Server) createRedirect(c *gin.Context) {
	var req CreateRedirectRequest
	if !bindJSON(c, &req) {
		return
	}
	from, problem := normalizeSitePath(req.FromPath)
	if problem == "" && isReservedSitePath(from) {
		problem = "can't be an admin, API or file path"
	}
	if problem != "" {
		redirectFieldError(c, "from_path", problem)
		return
	}
	if from == "/" {
		redirectFieldError(c, "from_path", "can't be the home page")
		return
	}
	to, problem := normalizeRedirectTarget(req.ToPath)
	if problem != "" {
		redirectFieldError(c, "to_path", problem)
		return
	}
	if to == from {
		c.JSON(http.StatusBadRequest, gin.H{"error": "a redirect can't point at its own address", "code": "redirect_loop"})
		return
	}
	status := req.StatusCode
	if status == 0 {
		status = http.StatusMovedPermanently
	}

	caller := getAuthPayload(c).UserID
	redirect, err := server.store.AddRedirectTx(c.Request.Context(), db.AddRedirectParams{
		FromPath:   from,
		ToPath:     to,
		StatusCode: status,
		Source:     db.RedirectSourceManual,
		CreatedBy:  caller,
	})
	switch {
	case errors.Is(err, db.ErrRedirectLoop):
		c.JSON(http.StatusBadRequest, gin.H{"error": "the redirect would lead back to its own address", "code": "redirect_loop"})
		return
	case errors.Is(err, db.ErrRedirectExists) || isUniqueViolation(err):
		c.JSON(http.StatusConflict, gin.H{"error": "this address already redirects", "code": "redirect_exists"})
		return
	case err != nil:
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to add the redirect"})
		return
	}

	server.recordRequestActivity(c, activityEvent{
		Verb:       db.ActivityRedirectCreated,
		ObjectType: db.ActivityObjectRedirect,
		ObjectID:   redirect.ID,
		Payload:    map[string]any{"status_code": redirect.StatusCode, "source": redirect.Source},
	})
	author := server.redirectAuthor(c, caller)
	c.JSON(http.StatusCreated, gin.H{"redirect": toRedirectResponse(redirect, author)})
}

// redirectAuthor is the caller as a list row's "Created by" (their row is loaded).
func (server *Server) redirectAuthor(c *gin.Context, userID int64) *RedirectAuthor {
	user, ok := server.callerUser(c)
	if !ok || user.ID != userID {
		return nil
	}
	return &RedirectAuthor{ID: user.ID, Username: user.Username, FullName: user.FullName, Avatar: avatarResponse(user.AvatarUrl)}
}

// listRedirects handles GET /redirects?q=&limit=&offset= (admins), newest first.
func (server *Server) listRedirects(c *gin.Context) {
	limit, offset := 50, 0
	if v := c.Query("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 100 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "limit must be 1 to 100"})
			return
		}
		limit = n
	}
	if v := c.Query("offset"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "offset must be 0 or more"})
			return
		}
		offset = n
	}
	query := strings.TrimSpace(c.Query("q"))
	if len(query) > 200 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "q is too long"})
		return
	}
	pattern := ""
	if query != "" {
		pattern = memberSearchPattern(query)
	}

	ctx := c.Request.Context()
	rows, err := server.store.ListRedirects(ctx, db.ListRedirectsParams{Query: pattern, RowLimit: int32(limit), RowOffset: int32(offset)})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list redirects"})
		return
	}
	total, err := server.store.CountRedirects(ctx, pattern)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to count redirects"})
		return
	}
	items := make([]RedirectResponse, len(rows))
	for i, row := range rows {
		var author *RedirectAuthor
		if row.CreatedBy.Valid && row.CreatedByUsername.Valid {
			author = &RedirectAuthor{
				ID:       row.CreatedBy.Int64,
				Username: row.CreatedByUsername.String,
				FullName: row.CreatedByFullName.String,
				Avatar:   avatarResponse(row.CreatedByAvatar.String),
			}
		}
		items[i] = toRedirectResponse(db.Redirect{
			ID: row.ID, FromPath: row.FromPath, ToPath: row.ToPath, StatusCode: row.StatusCode,
			Source: row.Source, CreatedBy: row.CreatedBy, CreatedAt: row.CreatedAt,
		}, author)
	}
	c.JSON(http.StatusOK, gin.H{"redirects": items, "total": total})
}

// deleteRedirect handles DELETE /redirects/:id (admins).
func (server *Server) deleteRedirect(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid redirect ID"})
		return
	}
	redirect, err := server.store.DeleteRedirect(c.Request.Context(), id)
	if errors.Is(err, sql.ErrNoRows) {
		c.JSON(http.StatusNotFound, gin.H{"error": "redirect not found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete the redirect"})
		return
	}
	server.recordRequestActivity(c, activityEvent{
		Verb:       db.ActivityRedirectDeleted,
		ObjectType: db.ActivityObjectRedirect,
		ObjectID:   redirect.ID,
		Payload:    map[string]any{"status_code": redirect.StatusCode, "source": redirect.Source},
	})
	c.Status(http.StatusNoContent)
}

// getPublicRedirect handles GET /public/redirects?path=: where the public site sends
// a request it would answer 404. 404 when the path doesn't redirect.
func (server *Server) getPublicRedirect(c *gin.Context) {
	path, problem := normalizeSitePath(c.Query("path"))
	if problem != "" || isReservedSitePath(path) {
		c.JSON(http.StatusNotFound, gin.H{"error": "no redirect"})
		return
	}
	redirect, err := server.store.GetRedirectByFromPath(c.Request.Context(), path)
	if errors.Is(err, sql.ErrNoRows) {
		c.JSON(http.StatusNotFound, gin.H{"error": "no redirect"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to look up the redirect"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"to_path": redirect.ToPath, "status_code": redirect.StatusCode})
}
