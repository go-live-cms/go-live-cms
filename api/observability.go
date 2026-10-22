// Package api — observability (#142, #155).
//
// This file holds the cross-cutting request middleware: request IDs, the
// structured access log, panic recovery and the pluggable error reporter.
//
// # Request IDs
//
// requestIDMiddleware runs first on every router. It keeps a well-formed
// incoming X-Request-ID only from a sender allowed to set one (a peer in
// TRUSTED_PROXIES on the public router; the collab WS server on the internal
// one) and otherwise generates one, stores it in the context (requestIDFromContext) and echoes it
// in the X-Request-ID response header. JSON error responses (status >= 400)
// also get a "request_id" field, so users can report it; that is done by a
// response-writer wrapper rather than in each handler's gin.H.
//
// # What is logged (low-PII, #155)
//
// One line per request: request id, method, route TEMPLATE (c.FullPath(), so
// ids, slugs and query strings never reach the log), status, latency, response
// size and the caller's user id when authenticated. Never: headers (the
// Authorization header and refresh cookie live there), the raw URL, query
// strings, request or response bodies. The client IP is logged only in debug
// mode. NewLogger also redacts attributes whose key names a credential, as a
// second line of defense.
package api

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"regexp"
	"runtime/debug"
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/go-live-cms/go-live-cms/token"
	"github.com/go-live-cms/go-live-cms/util"
	"github.com/google/uuid"
)

const (
	requestIDHeader = "X-Request-ID"
	// requestIDKey is the gin context key (and log/JSON field name) of the request id.
	requestIDKey = "request_id"
	// panicReportedKey marks a request whose panic recoveryMiddleware already
	// reported, so the access log doesn't report the resulting 500 again.
	panicReportedKey = "observability_panic_reported"
	// unmatchedRoute is logged (and used as the metrics label) for requests no
	// route matched, so arbitrary 404 paths can't reach the log or the metrics.
	unmatchedRoute = "(unmatched)"
)

// requestIDPattern is what an incoming X-Request-ID must look like to be kept.
// The charset can't break a log line or a JSON string, and covers UUIDs, hex ids
// and most proxy formats. Anything else is replaced with a fresh id.
var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{8,128}$`)

// validRequestID reports whether an incoming request id can be reused as is.
func validRequestID(id string) bool {
	return requestIDPattern.MatchString(id)
}

// requestIDMiddleware assigns every request an id (see the file comment) and
// wraps the writer so JSON error bodies carry it. An incoming X-Request-ID is
// only considered when trustIncoming(c) says the sender may set it; otherwise
// any client could pick an id (e.g. one another user reported) and muddy the
// logs.
func requestIDMiddleware(trustIncoming func(c *gin.Context) bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		id := ""
		if trustIncoming(c) {
			id = c.GetHeader(requestIDHeader)
		}
		if !validRequestID(id) {
			id = uuid.NewString()
		}
		c.Set(requestIDKey, id)
		c.Header(requestIDHeader, id)
		c.Writer = &requestIDErrorWriter{ResponseWriter: c.Writer, requestID: id}
		c.Next()
	}
}

// requestIDsFromProxies trusts an incoming X-Request-ID only when the TCP peer
// is one of TRUSTED_PROXIES (the same list gin uses for X-Forwarded-For), so a
// reverse proxy's id is kept but a direct client's is replaced.
func requestIDsFromProxies(trustedProxies []netip.Prefix) func(c *gin.Context) bool {
	return func(c *gin.Context) bool {
		return ipInPrefixes(c.RemoteIP(), trustedProxies)
	}
}

// trustRequestIDs keeps every incoming X-Request-ID. Only for the internal
// listener, whose only callers are other GoLive processes.
func trustRequestIDs(*gin.Context) bool { return true }

// requestIDFromContext returns the request id requestIDMiddleware assigned, or "".
func requestIDFromContext(c *gin.Context) string {
	return c.GetString(requestIDKey)
}

// requestIDErrorWriter adds "request_id" to the first write of a JSON error
// response (status >= 400 whose body is a JSON object). Gin's JSON renderers
// write the whole body in one call and set no Content-Length, so splicing the
// field into that write is safe. Other responses pass through untouched.
type requestIDErrorWriter struct {
	gin.ResponseWriter
	requestID string
	wrote     bool
}

func (w *requestIDErrorWriter) Write(b []byte) (int, error) {
	if w.wrote {
		return w.ResponseWriter.Write(b)
	}
	w.wrote = true
	if w.Status() >= http.StatusBadRequest &&
		strings.HasPrefix(w.Header().Get("Content-Type"), "application/json") {
		if out, ok := withRequestIDField(b, w.requestID); ok {
			if _, err := w.ResponseWriter.Write(out); err != nil {
				return 0, err
			}
			return len(b), nil
		}
	}
	return w.ResponseWriter.Write(b)
}

func (w *requestIDErrorWriter) WriteString(s string) (int, error) {
	return w.Write([]byte(s))
}

// withRequestIDField returns body with "request_id" as the object's first
// field. ok is false when body isn't a JSON object or already has the field.
// id needs no escaping: it is a UUID or matched requestIDPattern.
func withRequestIDField(body []byte, id string) ([]byte, bool) {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) < 2 || trimmed[0] != '{' || bytes.Contains(trimmed, []byte(`"`+requestIDKey+`"`)) {
		return nil, false
	}
	rest := bytes.TrimSpace(trimmed[1:])
	field := `{"` + requestIDKey + `":"` + id + `"`
	if rest[0] == '}' {
		return append([]byte(field), rest...), true
	}
	return append([]byte(field+","), rest...), true
}

// requestLog returns the server's logger with the request id attached, for
// handlers that log something besides the access line.
func (server *Server) requestLog(c *gin.Context) *slog.Logger {
	logger := server.logger
	if logger == nil { // a Server literal built by a test
		logger = slog.Default()
	}
	return logger.With(requestIDKey, requestIDFromContext(c))
}

// routeForLog is the matched route template, never the raw path.
func routeForLog(c *gin.Context) string {
	if route := c.FullPath(); route != "" {
		return route
	}
	return unmatchedRoute
}

// callerUserID returns the authenticated caller's id, if authMiddleware ran.
func callerUserID(c *gin.Context) (int64, bool) {
	value, ok := c.Get(authorizationPayloadKey)
	if !ok {
		return 0, false
	}
	payload, ok := value.(*token.Payload)
	if !ok || payload == nil {
		return 0, false
	}
	return payload.UserID, true
}

// requestLogger writes one structured line per request (see the file
// comment for the fields), records metrics when m is non-nil, and reports 5xx
// responses that weren't panics to the error reporter.
func (server *Server) requestLogger(logger *slog.Logger, m *httpMetrics) gin.HandlerFunc {
	includeClientIP := server.config.IsDebugMode()
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		latency := time.Since(start)

		status := c.Writer.Status()
		route := routeForLog(c)
		if m != nil {
			m.observe(c.Request.Method, route, status, latency)
		}

		attrs := []slog.Attr{
			slog.String(requestIDKey, requestIDFromContext(c)),
			slog.String("method", c.Request.Method),
			slog.String("route", route),
			slog.Int("status", status),
			slog.Float64("latency_ms", float64(latency.Microseconds())/1000),
			slog.Int("bytes", max(c.Writer.Size(), 0)), // Size is -1 when no body was written
		}
		userID, authenticated := callerUserID(c)
		if authenticated {
			attrs = append(attrs, slog.Int64("user_id", userID))
		}
		if includeClientIP {
			attrs = append(attrs, slog.String("client_ip", c.ClientIP()))
		}

		level := slog.LevelInfo
		if status >= http.StatusInternalServerError {
			level = slog.LevelError
		}
		logger.LogAttrs(c.Request.Context(), level, "http_request", attrs...)

		if status >= http.StatusInternalServerError && !c.GetBool(panicReportedKey) {
			event := ErrorEvent{
				RequestID: requestIDFromContext(c),
				Method:    c.Request.Method,
				Route:     route,
				Status:    status,
				UserID:    userID,
			}
			if last := c.Errors.Last(); last != nil {
				event.Err = last.Err
			} else {
				event.Err = fmt.Errorf("HTTP %d response", status)
			}
			server.reportError(c.Request.Context(), event)
		}
	}
}

// recoveryMiddleware replaces gin.Recovery: it logs the panic with its stack
// as a structured line, reports it, and answers 500 (the request id is added to
// the body by requestIDErrorWriter).
func (server *Server) recoveryMiddleware(logger *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		defer func() {
			rec := recover()
			if rec == nil {
				return
			}
			if rec == http.ErrAbortHandler {
				panic(rec) // net/http's sentinel for aborting a response; let it through
			}
			if err, ok := rec.(error); ok && isClientDisconnect(err) {
				// The client went away mid-response (as gin.Recovery special-cases):
				// not a server bug, so no stack, no report, and nothing to write.
				logger.LogAttrs(c.Request.Context(), slog.LevelWarn, "client_disconnected",
					slog.String(requestIDKey, requestIDFromContext(c)),
					slog.String("method", c.Request.Method),
					slog.String("route", routeForLog(c)),
					slog.String("error", err.Error()),
				)
				c.Set(panicReportedKey, true)
				c.Abort()
				return
			}
			stack := debug.Stack()
			err := fmt.Errorf("panic: %v", rec)
			logger.LogAttrs(c.Request.Context(), slog.LevelError, "panic_recovered",
				slog.String(requestIDKey, requestIDFromContext(c)),
				slog.String("method", c.Request.Method),
				slog.String("route", routeForLog(c)),
				slog.String("error", err.Error()),
				slog.String("stack", string(stack)),
			)
			userID, _ := callerUserID(c)
			server.reportError(c.Request.Context(), ErrorEvent{
				RequestID: requestIDFromContext(c),
				Method:    c.Request.Method,
				Route:     routeForLog(c),
				Status:    http.StatusInternalServerError,
				UserID:    userID,
				Err:       err,
				Stack:     stack,
			})
			c.Set(panicReportedKey, true)
			if c.Writer.Written() {
				c.Abort()
				return
			}
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "internal server error"})
		}()
		c.Next()
	}
}

// isClientDisconnect reports whether a panic value is a write to a connection
// the client already closed (broken pipe / connection reset).
func isClientDisconnect(err error) bool {
	if errors.Is(err, syscall.EPIPE) || errors.Is(err, syscall.ECONNRESET) {
		return true
	}
	var opErr *net.OpError
	if errors.As(err, &opErr) {
		msg := strings.ToLower(opErr.Error())
		return strings.Contains(msg, "broken pipe") || strings.Contains(msg, "connection reset by peer")
	}
	return false
}

// ErrorEvent is what the API hands an ErrorReporter: a recovered panic or a
// 5xx response. It deliberately carries no headers, bodies or query strings.
type ErrorEvent struct {
	RequestID string
	Method    string
	// Route is the matched route template (or "(unmatched)"), never the raw path.
	Route  string
	Status int
	// UserID is the authenticated caller, 0 when anonymous.
	UserID int64
	Err    error
	// Stack is set for panics only.
	Stack []byte
}

// ErrorReporter is the error-tracking seam (Sentry and the like). The default
// is a no-op; install one with Server.SetErrorReporter. ReportError is called
// on the request goroutine, so implementations should hand off and return fast.
type ErrorReporter interface {
	ReportError(ctx context.Context, event ErrorEvent)
}

type noopErrorReporter struct{}

func (noopErrorReporter) ReportError(context.Context, ErrorEvent) {}

// SetErrorReporter installs an error reporter (nil restores the no-op). Call
// it before Start; it is not synchronized with in-flight requests.
func (server *Server) SetErrorReporter(reporter ErrorReporter) {
	if reporter == nil {
		reporter = noopErrorReporter{}
	}
	server.errorReporter = reporter
}

func (server *Server) reportError(ctx context.Context, event ErrorEvent) {
	if server.errorReporter == nil {
		return
	}
	server.errorReporter.ReportError(ctx, event)
}

// redactedLogKeys are substrings of attribute keys whose values are never
// written, whatever a call site passes (#155). request_id and user_id are
// safe, and contain none of these.
var redactedLogKeys = []string{"authorization", "cookie", "password", "secret", "token", "ticket", "hash"}

func redactSensitiveAttr(_ []string, a slog.Attr) slog.Attr {
	key := strings.ToLower(a.Key)
	for _, sensitive := range redactedLogKeys {
		if strings.Contains(key, sensitive) {
			return slog.String(a.Key, "[REDACTED]")
		}
	}
	return a
}

// NewLogger builds the process logger: human-readable text at debug level in
// GIN_MODE=debug, JSON at info level otherwise (release, test). main installs
// it with slog.SetDefault, which also routes the standard log package through it.
func NewLogger(w io.Writer, ginMode string) *slog.Logger {
	if ginMode == util.GinModeDebug {
		return slog.New(slog.NewTextHandler(w, &slog.HandlerOptions{
			Level:       slog.LevelDebug,
			ReplaceAttr: redactSensitiveAttr,
		}))
	}
	return slog.New(slog.NewJSONHandler(w, &slog.HandlerOptions{
		Level:       slog.LevelInfo,
		ReplaceAttr: redactSensitiveAttr,
	}))
}

// runDetached runs f on its own goroutine, for work that must outlive the
// request (e.g. the forgot-password email). recoveryMiddleware only guards
// request goroutines, so a panic here would crash the process: it is
// recovered, logged and reported instead. route names the work for the
// report (a route template, never a raw path).
func (server *Server) runDetached(requestID, route string, f func()) {
	go func() {
		defer func() {
			rec := recover()
			if rec == nil {
				return
			}
			stack := debug.Stack()
			err := fmt.Errorf("panic: %v", rec)
			logger := server.logger
			if logger == nil {
				logger = slog.Default()
			}
			logger.LogAttrs(context.Background(), slog.LevelError, "background_panic_recovered",
				slog.String(requestIDKey, requestID),
				slog.String("route", route),
				slog.String("error", err.Error()),
				slog.String("stack", string(stack)),
			)
			server.reportError(context.Background(), ErrorEvent{
				RequestID: requestID,
				Route:     route,
				Status:    http.StatusInternalServerError,
				Err:       err,
				Stack:     stack,
			})
		}()
		f()
	}()
}
