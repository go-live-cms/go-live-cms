package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"syscall"
	"testing"

	"github.com/gin-gonic/gin"
	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	"github.com/go-live-cms/go-live-cms/token"
	"github.com/go-live-cms/go-live-cms/util"
	"github.com/golang/mock/gomock"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// recordingReporter is a test ErrorReporter.
type recordingReporter struct {
	mu     sync.Mutex
	events []ErrorEvent
}

func (r *recordingReporter) ReportError(_ context.Context, event ErrorEvent) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, event)
}

// newObservedEngine returns a bare engine with the same observability chain
// as setupRoutes, logging JSON into the returned buffer.
func newObservedEngine(t *testing.T, config util.Config) (*gin.Engine, *Server, *bytes.Buffer, *recordingReporter) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	var logs bytes.Buffer
	logger := NewLogger(&logs, util.GinModeRelease)
	reporter := &recordingReporter{}
	server := &Server{config: config, logger: logger, metrics: newHTTPMetrics()}
	server.SetErrorReporter(reporter)

	engine := gin.New()
	engine.Use(
		requestIDMiddleware(trustRequestIDs), // the trust rule has its own tests below
		server.requestLogger(logger, server.metrics),
		server.recoveryMiddleware(logger),
	)
	return engine, server, &logs, reporter
}

func serve(engine http.Handler, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)
	return rec
}

// logLines decodes the buffer's JSON log lines.
func logLines(t *testing.T, logs *bytes.Buffer) []map[string]any {
	t.Helper()
	var lines []map[string]any
	for _, raw := range strings.Split(strings.TrimSpace(logs.String()), "\n") {
		if raw == "" {
			continue
		}
		var line map[string]any
		require.NoError(t, json.Unmarshal([]byte(raw), &line), raw)
		lines = append(lines, line)
	}
	return lines
}

func TestRequestIDGeneratedWhenMissing(t *testing.T) {
	engine, _, _, _ := newObservedEngine(t, util.Config{})
	var seen string
	engine.GET("/x", func(c *gin.Context) {
		seen = requestIDFromContext(c)
		c.Status(http.StatusNoContent)
	})

	rec := serve(engine, httptest.NewRequest(http.MethodGet, "/x", nil))

	id := rec.Header().Get(requestIDHeader)
	_, err := uuid.Parse(id)
	require.NoError(t, err, "generated id should be a UUID, got %q", id)
	require.Equal(t, id, seen)
}

func TestRequestIDPropagatedWhenWellFormed(t *testing.T) {
	engine, _, _, _ := newObservedEngine(t, util.Config{})
	var seen string
	engine.GET("/x", func(c *gin.Context) {
		seen = requestIDFromContext(c)
		c.Status(http.StatusNoContent)
	})

	for _, id := range []string{"0123456789abcdef0123456789abcdef", "edge-proxy.req:42_ab"} {
		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		req.Header.Set(requestIDHeader, id)
		rec := serve(engine, req)
		require.Equal(t, id, rec.Header().Get(requestIDHeader))
		require.Equal(t, id, seen)
	}
}

func TestRequestIDInvalidIncomingIsReplaced(t *testing.T) {
	engine, _, _, _ := newObservedEngine(t, util.Config{})
	engine.GET("/x", func(c *gin.Context) { c.Status(http.StatusNoContent) })

	for _, bad := range []string{
		"short",                       // too short
		strings.Repeat("a", 129),      // too long
		"has spaces in it",            // separators
		`quote"injection-attempt`,     // would break JSON
		"line\nbreak-forged-log-line", // would forge a log line
		"ünïcödé-request-id",
	} {
		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		req.Header.Set(requestIDHeader, bad)
		rec := serve(engine, req)
		got := rec.Header().Get(requestIDHeader)
		require.NotEqual(t, bad, got)
		_, err := uuid.Parse(got)
		require.NoError(t, err, "invalid %q should be replaced by a UUID, got %q", bad, got)
	}
}

func TestErrorResponsesCarryRequestID(t *testing.T) {
	engine, _, _, _ := newObservedEngine(t, util.Config{})
	engine.GET("/unauthorized", func(c *gin.Context) {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "nope"})
	})
	engine.GET("/empty", func(c *gin.Context) { c.JSON(http.StatusBadRequest, gin.H{}) })
	engine.GET("/ok", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok"}) })
	engine.GET("/text", func(c *gin.Context) { c.String(http.StatusBadRequest, "plain") })

	req := httptest.NewRequest(http.MethodGet, "/unauthorized", nil)
	req.Header.Set(requestIDHeader, "client-supplied-id-123")
	rec := serve(engine, req)
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	require.JSONEq(t, `{"request_id":"client-supplied-id-123","error":"nope"}`, rec.Body.String())

	rec = serve(engine, httptest.NewRequest(http.MethodGet, "/empty", nil))
	require.JSONEq(t, `{"request_id":"`+rec.Header().Get(requestIDHeader)+`"}`, rec.Body.String())

	// Successes and non-JSON bodies are untouched.
	rec = serve(engine, httptest.NewRequest(http.MethodGet, "/ok", nil))
	require.JSONEq(t, `{"status":"ok"}`, rec.Body.String())
	rec = serve(engine, httptest.NewRequest(http.MethodGet, "/text", nil))
	require.Equal(t, "plain", rec.Body.String())
}

func TestServerErrorResponsesCarryRequestID(t *testing.T) {
	ctrl := gomock.NewController(t)
	server := newTestServer(t, mockdb.NewMockStore(ctrl))

	// No Authorization header: authMiddleware answers 401 without a store call.
	rec := serve(server.router, httptest.NewRequest(http.MethodPost, "/api/v1/collab/tickets", nil))
	require.Equal(t, http.StatusUnauthorized, rec.Code)

	var body map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.NotEmpty(t, body["error"])
	require.Equal(t, rec.Header().Get(requestIDHeader), body["request_id"])
}

func TestAccessLogFieldsAndNoSecrets(t *testing.T) {
	engine, _, logs, _ := newObservedEngine(t, util.Config{GinMode: util.GinModeRelease})
	engine.POST("/api/v1/posts/:id", func(c *gin.Context) {
		c.Set(authorizationPayloadKey, &token.Payload{UserID: 7})
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})

	const (
		bearer   = "v4.public.SECRET-ACCESS-TOKEN"
		cookie   = "SECRET-REFRESH-COOKIE"
		password = "SECRET-PASSWORD-hunter2"
		query    = "SECRET-QUERY-TICKET"
	)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/posts/SECRET-POST-ID?ticket="+query,
		strings.NewReader(`{"password":"`+password+`"}`))
	req.Header.Set("Authorization", "Bearer "+bearer)
	req.Header.Set("Cookie", "__Host-refresh_token="+cookie)
	req.Header.Set(requestIDHeader, "trace-me-12345")
	serve(engine, req)

	out := logs.String()
	for _, secret := range []string{bearer, cookie, password, query, "SECRET-POST-ID"} {
		require.NotContains(t, out, secret)
	}

	lines := logLines(t, logs)
	require.Len(t, lines, 1)
	line := lines[0]
	require.Equal(t, "http_request", line["msg"])
	require.Equal(t, "trace-me-12345", line["request_id"])
	require.Equal(t, "POST", line["method"])
	require.Equal(t, "/api/v1/posts/:id", line["route"])
	require.EqualValues(t, 200, line["status"])
	require.EqualValues(t, 7, line["user_id"])
	require.Contains(t, line, "latency_ms")
	require.NotContains(t, line, "client_ip", "client IPs are not logged outside debug mode")
}

func TestAccessLogClientIPOnlyInDebug(t *testing.T) {
	engine, _, logs, _ := newObservedEngine(t, util.Config{GinMode: util.GinModeDebug})
	engine.GET("/x", func(c *gin.Context) { c.Status(http.StatusNoContent) })
	serve(engine, httptest.NewRequest(http.MethodGet, "/x", nil))

	lines := logLines(t, logs)
	require.Len(t, lines, 1)
	require.Contains(t, lines[0], "client_ip")
}

func TestAccessLogUnmatchedRouteHidesPath(t *testing.T) {
	engine, server, logs, _ := newObservedEngine(t, util.Config{})
	serve(engine, httptest.NewRequest(http.MethodGet, "/no/such/SECRET-PATH", nil))

	require.NotContains(t, logs.String(), "SECRET-PATH")
	require.Equal(t, unmatchedRoute, logLines(t, logs)[0]["route"])
	require.NotContains(t, server.metrics.render(), "SECRET-PATH")
}

func TestLoggerRedactsSensitiveKeys(t *testing.T) {
	for _, mode := range []string{util.GinModeRelease, util.GinModeDebug} {
		var logs bytes.Buffer
		NewLogger(&logs, mode).Info("event",
			"password", "hunter2",
			"Authorization", "Bearer abc.def",
			"refresh_token", "rt-value",
			"password_hash", "$argon2id$x",
			"user_id", 5,
		)
		out := logs.String()
		for _, secret := range []string{"hunter2", "abc.def", "rt-value", "argon2id"} {
			require.NotContains(t, out, secret, mode)
		}
		require.Contains(t, out, "REDACTED", mode)
		require.Contains(t, out, "user_id", mode)
	}
}

func TestRecoveryLogsReportsAndAnswers500(t *testing.T) {
	engine, _, logs, reporter := newObservedEngine(t, util.Config{})
	engine.GET("/boom", func(c *gin.Context) { panic("kaboom") })

	rec := serve(engine, httptest.NewRequest(http.MethodGet, "/boom", nil))
	require.Equal(t, http.StatusInternalServerError, rec.Code)
	id := rec.Header().Get(requestIDHeader)
	require.JSONEq(t, `{"request_id":"`+id+`","error":"internal server error"}`, rec.Body.String())

	require.Len(t, reporter.events, 1, "a panic is reported once, not again as a 5xx")
	event := reporter.events[0]
	require.Equal(t, id, event.RequestID)
	require.Equal(t, "/boom", event.Route)
	require.Equal(t, http.StatusInternalServerError, event.Status)
	require.ErrorContains(t, event.Err, "kaboom")
	require.NotEmpty(t, event.Stack)

	var msgs []string
	for _, line := range logLines(t, logs) {
		msgs = append(msgs, line["msg"].(string))
	}
	require.Equal(t, []string{"panic_recovered", "http_request"}, msgs)
}

func TestServerErrorIsReported(t *testing.T) {
	engine, _, _, reporter := newObservedEngine(t, util.Config{})
	engine.GET("/fail", func(c *gin.Context) {
		_ = c.Error(errors.New("db exploded"))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed"})
	})
	engine.GET("/client-error", func(c *gin.Context) { c.JSON(http.StatusNotFound, gin.H{"error": "missing"}) })

	serve(engine, httptest.NewRequest(http.MethodGet, "/fail", nil))
	serve(engine, httptest.NewRequest(http.MethodGet, "/client-error", nil))

	require.Len(t, reporter.events, 1, "only 5xx responses are reported")
	require.ErrorContains(t, reporter.events[0].Err, "db exploded")
	require.Nil(t, reporter.events[0].Stack)
}

func TestSetErrorReporterNilRestoresNoop(t *testing.T) {
	server := &Server{}
	server.SetErrorReporter(nil)
	require.NotPanics(t, func() { server.reportError(context.Background(), ErrorEvent{}) })
}

func TestRequestIDOnlyTrustedFromProxies(t *testing.T) {
	const incoming = "proxy-assigned-id-123"
	// httptest requests come from 192.0.2.1.
	for _, tc := range []struct {
		name           string
		trustedProxies string
		kept           bool
	}{
		{"no trusted proxies: a direct client can't pick its id", "", false},
		{"peer not in TRUSTED_PROXIES", "10.0.0.0/8", false},
		{"peer in TRUSTED_PROXIES (CIDR)", "10.0.0.0/8,192.0.2.0/24", true},
		{"peer in TRUSTED_PROXIES (bare IP)", "192.0.2.1", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			config := newTestConfig(t)
			config.TrustedProxies = tc.trustedProxies
			server, err := NewServer(config, mockdb.NewMockStore(ctrl))
			require.NoError(t, err)

			req := httptest.NewRequest(http.MethodGet, "/health", nil)
			req.Header.Set(requestIDHeader, incoming)
			got := serve(server.router, req).Header().Get(requestIDHeader)
			if tc.kept {
				require.Equal(t, incoming, got)
			} else {
				require.NotEqual(t, incoming, got)
				_, err := uuid.Parse(got)
				require.NoError(t, err)
			}
		})
	}
}

func TestInternalListenerKeepsForwardedRequestID(t *testing.T) {
	ctrl := gomock.NewController(t)
	server := newTestServer(t, mockdb.NewMockStore(ctrl))

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	req.Header.Set(requestIDHeader, "ws-upgrade-id-12345")
	rec := serve(server.internalRouter, req)
	require.Equal(t, "ws-upgrade-id-12345", rec.Header().Get(requestIDHeader))
}

func TestRecoveryTreatsClientDisconnectAsWarning(t *testing.T) {
	engine, _, logs, reporter := newObservedEngine(t, util.Config{})
	engine.GET("/download", func(c *gin.Context) {
		c.Status(http.StatusOK)
		panic(&net.OpError{Op: "write", Net: "tcp", Err: os.NewSyscallError("write", syscall.EPIPE)})
	})

	rec := serve(engine, httptest.NewRequest(http.MethodGet, "/download", nil))
	require.NotContains(t, rec.Body.String(), "internal server error")
	require.Empty(t, reporter.events, "a client hanging up is not reported as a server error")

	lines := logLines(t, logs)
	require.Equal(t, "client_disconnected", lines[0]["msg"])
	require.Equal(t, "WARN", lines[0]["level"])
	require.NotContains(t, lines[0], "stack")
}

func TestIsClientDisconnect(t *testing.T) {
	require.True(t, isClientDisconnect(os.NewSyscallError("write", syscall.ECONNRESET)))
	require.True(t, isClientDisconnect(&net.OpError{Op: "write", Err: errors.New("write: broken pipe")}))
	require.False(t, isClientDisconnect(errors.New("nil map assignment")))
}

func TestAccessLogBytesNeverNegative(t *testing.T) {
	engine, _, logs, _ := newObservedEngine(t, util.Config{})
	engine.GET("/empty", func(c *gin.Context) { c.Status(http.StatusNoContent) })
	serve(engine, httptest.NewRequest(http.MethodGet, "/empty", nil))
	require.EqualValues(t, 0, logLines(t, logs)[0]["bytes"])
}

func TestReadinessReflectsDatabase(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	server := newTestServer(t, store)

	// NewServer wires /readyz to the store's Ping.
	store.EXPECT().Ping(gomock.Any()).Return(errors.New("dial tcp postgres:5432: connection refused"))
	rec := serve(server.router, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	require.Equal(t, http.StatusServiceUnavailable, rec.Code)
	require.NotContains(t, rec.Body.String(), "connection refused", "error details are logged, not returned")
	var body map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, "unavailable", body["status"])
	require.Equal(t, map[string]any{"database": "down"}, body["checks"])
	require.NotEmpty(t, body["request_id"])

	var gotDeadline bool
	store.EXPECT().Ping(gomock.Any()).DoAndReturn(func(ctx context.Context) error {
		_, gotDeadline = ctx.Deadline()
		return nil
	})
	rec = serve(server.router, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	require.Equal(t, http.StatusOK, rec.Code)
	require.JSONEq(t, `{"status":"ok","checks":{"database":"ok"}}`, rec.Body.String())
	require.True(t, gotDeadline, "the DB ping must have a timeout")
}

func TestLivenessRoutes(t *testing.T) {
	ctrl := gomock.NewController(t)
	server := newTestServer(t, mockdb.NewMockStore(ctrl))
	for _, path := range []string{"/health", "/api/v1/health"} {
		rec := serve(server.router, httptest.NewRequest(http.MethodGet, path, nil))
		require.Equal(t, http.StatusOK, rec.Code, path)
	}
}

func TestMetricsOnInternalListenerOnly(t *testing.T) {
	ctrl := gomock.NewController(t)
	server := newTestServer(t, mockdb.NewMockStore(ctrl))

	serve(server.router, httptest.NewRequest(http.MethodGet, "/health", nil))
	serve(server.router, httptest.NewRequest(http.MethodGet, "/health", nil))
	serve(server.router, httptest.NewRequest("BREW", "/health", nil))

	// Not on the public router.
	rec := serve(server.router, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	require.Equal(t, http.StatusNotFound, rec.Code)

	rec = serve(server.internalRouter, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	require.Equal(t, http.StatusOK, rec.Code)
	out := rec.Body.String()
	require.Contains(t, out, `golive_http_requests_total{method="GET",route="/health",status="200"} 2`)
	require.Contains(t, out, `golive_http_request_duration_seconds_count{method="GET",route="/health",status="200"} 2`)
	require.Contains(t, out, `golive_http_request_duration_seconds_bucket{method="GET",route="/health",status="200",le="+Inf"} 2`)
	require.Contains(t, out, `method="OTHER"`, "unknown methods are folded into one label")
	require.NotContains(t, out, "BREW")
}

func TestMetricsEscapeLabels(t *testing.T) {
	require.Equal(t, `a\"b\\c\n`, escapeLabel("a\"b\\c\n"))
}
