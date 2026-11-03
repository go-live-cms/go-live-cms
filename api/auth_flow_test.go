package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	p "aidanwoods.dev/go-paseto"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	_ "github.com/lib/pq"
	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/token"
	"github.com/go-live-cms/go-live-cms/util"
)

// Auth flow tests (#162): login, refresh, reuse and logout through the real
// router and handlers against the test database (CI's Postgres; skipped
// without one), so the row locks, the rotation transaction and the session
// rows are the real ones. The mock-store tests (session_refresh_test.go,
// session_test.go) cover the handlers' branches; these cover what only the
// database can show.

const authFlowPassword = "flow-password-123"

// authFlowStore returns a store on the test database, or skips.
func authFlowStore(t *testing.T) db.Store {
	t.Helper()
	config, err := util.LoadConfig("..")
	if err != nil || config.DBSource == "" {
		t.Skip("no test database configured")
	}
	conn, err := sql.Open(config.DBDriver, config.DBSource)
	require.NoError(t, err)
	t.Cleanup(func() { conn.Close() })
	if err := conn.Ping(); err != nil {
		t.Skipf("test database unreachable: %v", err)
	}
	return db.NewStore(conn)
}

// authFlowUser creates a user with authFlowPassword.
func authFlowUser(t *testing.T, store db.Store) db.User {
	t.Helper()
	hashed, err := util.HashPassword(authFlowPassword)
	require.NoError(t, err)
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:16]
	user, err := store.CreateUser(context.Background(), db.CreateUserParams{
		Username:       "flow" + suffix,
		FullName:       "Flow Tester",
		Email:          "flow" + suffix + "@example.test",
		HashedPassword: hashed,
		Role:           RoleContributor,
	})
	require.NoError(t, err)
	return user
}

// authFlowServer is a real server on store; adjust config before it's built.
func authFlowServer(t *testing.T, store db.Store, adjust func(*util.Config)) *Server {
	t.Helper()
	config := newTestConfig(t)
	if adjust != nil {
		adjust(&config)
	}
	server, err := NewServer(config, store)
	require.NoError(t, err)
	return server
}

func flowServe(server *Server, request *http.Request) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	return recorder
}

// flowLogin signs user in and returns the access token and the refresh cookie.
func flowLogin(t *testing.T, server *Server, user db.User) (string, *http.Cookie) {
	t.Helper()
	body, err := json.Marshal(gin.H{"username": user.Username, "password": authFlowPassword})
	require.NoError(t, err)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	recorder := flowServe(server, request)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())

	var rsp LoginUserResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
	return rsp.AccessToken, findRefreshCookie(t, recorder, server.refreshCookieName())
}

// flowRefresh posts to /auth/refresh with cookie (as the browser sends it back:
// name and value only).
func flowRefresh(server *Server, cookie *http.Cookie) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/refresh", nil)
	request.AddCookie(&http.Cookie{Name: cookie.Name, Value: cookie.Value})
	return flowServe(server, request)
}

func flowLogout(server *Server, access string, cookie *http.Cookie) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	request.Header.Set("Authorization", "Bearer "+access)
	request.AddCookie(&http.Cookie{Name: cookie.Name, Value: cookie.Value})
	return flowServe(server, request)
}

func flowGetMe(server *Server, access string) int {
	request := httptest.NewRequest(http.MethodGet, "/api/v1/users/me", nil)
	request.Header.Set("Authorization", "Bearer "+access)
	return flowServe(server, request).Code
}

// sessionByToken returns the session row of a refresh token (blocked or not).
func sessionByToken(t *testing.T, store db.Store, refreshToken string) db.Session {
	t.Helper()
	session, err := store.GetAnySessionByRefreshTokenHash(context.Background(), token.HashRefresh(refreshToken))
	require.NoError(t, err)
	return session
}

func userSessions(t *testing.T, store db.Store, userID int64) []db.Session {
	t.Helper()
	sessions, err := store.ListSessionsByUser(context.Background(), userID)
	require.NoError(t, err)
	return sessions
}

func activeSessions(sessions []db.Session) int {
	n := 0
	for _, s := range sessions {
		if !s.IsBlocked {
			n++
		}
	}
	return n
}

// captureLogs sends slog's default logger to a buffer for the test and returns
// the JSON lines written so far on each call.
func captureLogs(t *testing.T) func() []map[string]any {
	t.Helper()
	var mu sync.Mutex
	var buf bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&lockedWriter{mu: &mu, w: &buf}, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return func() []map[string]any {
		mu.Lock()
		defer mu.Unlock()
		var lines []map[string]any
		for _, line := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
			var entry map[string]any
			if json.Unmarshal([]byte(line), &entry) == nil {
				lines = append(lines, entry)
			}
		}
		return lines
	}
}

type lockedWriter struct {
	mu *sync.Mutex
	w  *bytes.Buffer
}

func (l *lockedWriter) Write(b []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(b)
}

// securityEvents returns the session_security_event lines with event name.
func securityEvents(lines []map[string]any, event string) []map[string]any {
	var out []map[string]any
	for _, line := range lines {
		if line["msg"] == "session_security_event" && line["event"] == event {
			out = append(out, line)
		}
	}
	return out
}

// Many refreshes racing with one refresh token: exactly one rotates it. The
// others wait on the session row lock and then find it rotated (401), or
// arrive after the commit and are treated as reuse (409). Either way the
// losers' new sessions are rolled back, so the family gains exactly one.
func TestAuthFlowConcurrentRefreshDB(t *testing.T) {
	store := authFlowStore(t)
	server := authFlowServer(t, store, nil)
	user := authFlowUser(t, store)
	_, cookie := flowLogin(t, server, user)
	original := sessionByToken(t, store, cookie.Value)

	const racers = 8
	var wg sync.WaitGroup
	start := make(chan struct{})
	recorders := make([]*httptest.ResponseRecorder, racers)
	for i := range recorders {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			recorders[i] = flowRefresh(server, cookie)
		}(i)
	}
	close(start)
	wg.Wait()

	var winner *httptest.ResponseRecorder
	reuse := 0
	for _, recorder := range recorders {
		switch recorder.Code {
		case http.StatusOK:
			require.Nil(t, winner, "two refreshes with one token succeeded")
			winner = recorder
		case http.StatusConflict:
			reuse++
		case http.StatusUnauthorized:
		default:
			t.Fatalf("unexpected status %d: %s", recorder.Code, recorder.Body.String())
		}
	}
	require.NotNil(t, winner, "no refresh succeeded")

	newCookie := findRefreshCookie(t, winner, server.refreshCookieName())
	rotated := sessionByToken(t, store, cookie.Value)
	require.True(t, rotated.IsBlocked)
	require.True(t, rotated.ReplacedBy.Valid)
	successor := sessionByToken(t, store, newCookie.Value)
	require.Equal(t, rotated.ReplacedBy.UUID, successor.ID, "the winner's session replaced the original")

	sessions := userSessions(t, store, user.ID)
	require.Len(t, sessions, 2, "only the winner's new session survives")
	ids := []uuid.UUID{sessions[0].ID, sessions[1].ID}
	require.ElementsMatch(t, []uuid.UUID{original.ID, successor.ID}, ids)

	if reuse == 0 {
		// Every loser waited on the lock: the winner's session is intact.
		require.Equal(t, 1, activeSessions(sessions))
		require.Equal(t, http.StatusOK, flowRefresh(server, newCookie).Code)
	} else {
		// A loser saw the rotated token: reuse, every session blocked.
		require.Equal(t, 0, activeSessions(sessions))
	}
}

// Refresh-token reuse, the incident path: a rotated token presented again
// blocks every session of the user (the rotated family and the user's other
// devices), answers 409 and logs a refresh_token_reuse warning naming the
// session whose token came back. The successors then just get 401.
func TestAuthFlowRefreshReuseDB(t *testing.T) {
	store := authFlowStore(t)
	server := authFlowServer(t, store, nil)
	user := authFlowUser(t, store)
	logs := captureLogs(t)

	_, stolen := flowLogin(t, server, user)      // device A
	_, otherDevice := flowLogin(t, server, user) // device B
	stolenSession := sessionByToken(t, store, stolen.Value)

	rsp := flowRefresh(server, stolen) // A rotates: stolen is now spent
	require.Equal(t, http.StatusOK, rsp.Code)
	successor := findRefreshCookie(t, rsp, server.refreshCookieName())
	require.Equal(t, 1, activeSessionsBesides(t, store, user.ID, otherDevice.Value), "A's successor is the only other live session")

	rsp = flowRefresh(server, stolen) // the spent token comes back
	require.Equal(t, http.StatusConflict, rsp.Code)
	require.Contains(t, rsp.Body.String(), "refresh token reuse detected")
	require.Nil(t, findCookie(rsp, server.refreshCookieName()), "no new refresh token for a reused one")

	sessions := userSessions(t, store, user.ID)
	require.Len(t, sessions, 3)
	require.Equal(t, 0, activeSessions(sessions), "every session of the user is blocked")

	events := securityEvents(logs(), LogSessionReuse)
	require.Len(t, events, 1)
	require.Equal(t, "WARN", events[0]["level"])
	require.Equal(t, stolenSession.ID.String(), events[0]["session_id"])
	require.EqualValues(t, user.ID, events[0]["user_id"])
	require.NotEmpty(t, events[0]["request_id"])
	for _, line := range logs() {
		encoded, _ := json.Marshal(line)
		require.NotContains(t, string(encoded), stolen.Value, "a refresh token was logged")
		require.NotContains(t, string(encoded), user.Username, "a username was logged")
	}

	// The successor and the other device were revoked, not rotated: 401, and
	// no second reuse incident.
	for _, cookie := range []*http.Cookie{successor, otherDevice} {
		rsp = flowRefresh(server, cookie)
		require.Equal(t, http.StatusUnauthorized, rsp.Code)
		require.Contains(t, rsp.Body.String(), ErrSessionBlocked)
	}
	require.Len(t, securityEvents(logs(), LogSessionReuse), 1)
}

// activeSessionsBesides counts the user's live sessions other than the one of
// refreshToken.
func activeSessionsBesides(t *testing.T, store db.Store, userID int64, refreshToken string) int {
	t.Helper()
	skip := sessionByToken(t, store, refreshToken).ID
	n := 0
	for _, s := range userSessions(t, store, userID) {
		if !s.IsBlocked && s.ID != skip {
			n++
		}
	}
	return n
}

// Logout blocks only its own session and clears the cookie; that refresh
// token then fails with 401 (not reuse), and the user's other session keeps
// working.
func TestAuthFlowLogoutThenRefreshDB(t *testing.T) {
	store := authFlowStore(t)
	server := authFlowServer(t, store, nil)
	user := authFlowUser(t, store)
	logs := captureLogs(t)

	access, cookie := flowLogin(t, server, user)
	_, otherDevice := flowLogin(t, server, user)

	rsp := flowLogout(server, access, cookie)
	require.Equal(t, http.StatusOK, rsp.Code)
	cleared := findRefreshCookie(t, rsp, server.refreshCookieName())
	require.Empty(t, cleared.Value)
	require.Equal(t, -1, cleared.MaxAge)

	session := sessionByToken(t, store, cookie.Value)
	require.True(t, session.IsBlocked)
	require.False(t, session.ReplacedBy.Valid)

	rsp = flowRefresh(server, cookie)
	require.Equal(t, http.StatusUnauthorized, rsp.Code)
	require.Contains(t, rsp.Body.String(), ErrSessionBlocked)
	require.Empty(t, securityEvents(logs(), LogSessionReuse), "a logged-out token is not reuse")

	require.Equal(t, http.StatusOK, flowRefresh(server, otherDevice).Code, "the other session is untouched")

	// Logging out again with the dead cookie still succeeds and clears it.
	rsp = flowLogout(server, access, cookie)
	require.Equal(t, http.StatusOK, rsp.Code)
	require.Equal(t, -1, findRefreshCookie(t, rsp, server.refreshCookieName()).MaxAge)
}

// The refresh cookie through login, refresh and logout, in production
// (__Host-, #159) and in plain-HTTP development.
func TestAuthFlowCookiesDB(t *testing.T) {
	store := authFlowStore(t)

	testCases := []struct {
		name         string
		ginMode      string
		cookieSecure bool
		domain       string
		wantName     string
		wantPath     string
		wantSecure   bool
		wantDomain   string
		otherName    string
	}{
		{name: "release", ginMode: util.GinModeRelease, domain: "example.com",
			wantName: HostRefreshCookieName, wantPath: "/", wantSecure: true, otherName: RefreshCookieName},
		{name: "debug over HTTP", ginMode: util.GinModeDebug, domain: "dev.example.com",
			wantName: RefreshCookieName, wantPath: CookiePath, wantDomain: "dev.example.com", otherName: HostRefreshCookieName},
		{name: "debug with COOKIE_SECURE", ginMode: util.GinModeDebug, cookieSecure: true, domain: "dev.example.com",
			wantName: HostRefreshCookieName, wantPath: "/", wantSecure: true, otherName: RefreshCookieName},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			server := authFlowServer(t, store, func(c *util.Config) {
				c.GinMode = tc.ginMode
				c.CookieSecure = tc.cookieSecure
				c.CookieDomain = tc.domain
			})
			user := authFlowUser(t, store)
			requireCookie := func(cookie *http.Cookie, what string) {
				t.Helper()
				require.Equal(t, tc.wantName, cookie.Name, what)
				require.Equal(t, tc.wantPath, cookie.Path, what)
				require.Equal(t, tc.wantSecure, cookie.Secure, what)
				require.Equal(t, tc.wantDomain, cookie.Domain, what)
				require.True(t, cookie.HttpOnly, what)
				require.Equal(t, http.SameSiteStrictMode, cookie.SameSite, what)
			}

			access, cookie := flowLogin(t, server, user)
			requireCookie(cookie, "login")
			require.WithinDuration(t, time.Now().Add(time.Hour), cookie.Expires, time.Minute, "lives as long as the refresh token")

			// Only the mode's own name is read.
			rsp := flowRefresh(server, &http.Cookie{Name: tc.otherName, Value: cookie.Value})
			require.Equal(t, http.StatusBadRequest, rsp.Code)

			rsp = flowRefresh(server, cookie)
			require.Equal(t, http.StatusOK, rsp.Code)
			rotated := findRefreshCookie(t, rsp, tc.wantName)
			requireCookie(rotated, "refresh")
			require.NotEqual(t, cookie.Value, rotated.Value, "refresh rotates the token")
			require.Equal(t, "no-store", rsp.Header().Get("Cache-Control"))

			rsp = flowLogout(server, access, rotated)
			require.Equal(t, http.StatusOK, rsp.Code)
			cleared := findRefreshCookie(t, rsp, tc.wantName)
			requireCookie(cleared, "logout")
			require.Equal(t, -1, cleared.MaxAge)
		})
	}
}

// Key rotation through the API (#158): after a deploy with new keys and the
// old ones as previous keys, tokens the old keys issued keep working until
// they expire, and the refresh moves the session onto the new keys.
func TestAuthFlowKeyRotationDB(t *testing.T) {
	store := authFlowStore(t)
	user := authFlowUser(t, store)

	before := newTestConfig(t)
	before.PasetoAccessKID, before.PasetoRefreshKID = "k4.pub.2026-01", "k4.loc.2026-01"
	oldServer, err := NewServer(before, store)
	require.NoError(t, err)
	access, cookie := flowLogin(t, oldServer, user)

	newPriv, newLocal := p.NewV4AsymmetricSecretKey(), p.NewV4SymmetricKey()
	rotate := func(c *util.Config) {
		*c = before
		c.PasetoV4PrivateKeyHex = newPriv.ExportHex()
		c.PasetoV4PublicKeyHex = newPriv.Public().ExportHex()
		c.PasetoV4LocalKeyHex = newLocal.ExportHex()
		c.PasetoAccessKID, c.PasetoRefreshKID = "k4.pub.2026-11", "k4.loc.2026-11"
	}

	// The new keys alone: every old token is rejected (the compromise case).
	strict := authFlowServer(t, store, rotate)
	require.Equal(t, http.StatusUnauthorized, flowGetMe(strict, access))
	require.Equal(t, http.StatusUnauthorized, flowRefresh(strict, cookie).Code)

	// With the old keys as previous keys, by their KIDs.
	rotated := authFlowServer(t, store, func(c *util.Config) {
		rotate(c)
		c.PasetoV4PreviousPublicKeys = fmt.Sprintf("%s=%s", before.PasetoAccessKID, before.PasetoV4PublicKeyHex)
		c.PasetoV4PreviousLocalKeys = fmt.Sprintf("%s=%s", before.PasetoRefreshKID, before.PasetoV4LocalKeyHex)
		c.PasetoPreviousKeysValidUntil = time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	})
	require.Equal(t, http.StatusOK, flowGetMe(rotated, access), "an old access token verifies")

	rsp := flowRefresh(rotated, cookie)
	require.Equal(t, http.StatusOK, rsp.Code, rsp.Body.String())
	var renewed RenewAccessTokenResponse
	require.NoError(t, json.Unmarshal(rsp.Body.Bytes(), &renewed))
	newCookie := findRefreshCookie(t, rsp, rotated.refreshCookieName())

	// The new tokens are the new keys' only: the strict server takes them.
	require.Equal(t, http.StatusOK, flowGetMe(strict, renewed.AccessToken))
	session := sessionByToken(t, store, newCookie.Value)
	require.Equal(t, "k4.loc.2026-11", session.RefreshKid.String)
	require.Equal(t, http.StatusOK, flowRefresh(strict, newCookie).Code)
}

// Last active (#333): login stamps last_active_at; requests and a refresh inside
// LAST_ACTIVE_INTERVAL don't write it again.
func TestAuthFlowLastActive(t *testing.T) {
	store := authFlowStore(t)
	server := authFlowServer(t, store, func(c *util.Config) { c.LastActiveInterval = 5 * time.Minute })
	user := authFlowUser(t, store)
	ctx := context.Background()
	lastActive := func() sql.NullTime {
		row, err := store.GetUser(ctx, user.ID)
		require.NoError(t, err)
		return row.LastActiveAt
	}
	require.False(t, lastActive().Valid)

	access, cookie := flowLogin(t, server, user)
	stamped := lastActive()
	require.True(t, stamped.Valid)

	// Within the interval: requests and a refresh leave it as it is.
	require.Equal(t, http.StatusOK, flowGetMe(server, access))
	refreshed := flowRefresh(server, cookie)
	require.Equal(t, http.StatusOK, refreshed.Code, refreshed.Body.String())
	require.True(t, lastActive().Time.Equal(stamped.Time))
	// Stale rows: TestAuthMiddlewareLastActive and db's TestTouchUserLastActive.
}

// Removing a member (#333) ends every way back in: their access token gets 403
// at once (the row is gone) and their refresh token 401 (sessions deleted).
func TestAuthFlowRemovedMember(t *testing.T) {
	store := authFlowStore(t)
	server := authFlowServer(t, store, nil)
	member := authFlowUser(t, store)
	recipient := authFlowUser(t, store)

	access, cookie := flowLogin(t, server, member)
	require.Equal(t, http.StatusOK, flowGetMe(server, access))

	_, err := store.RemoveUserTx(context.Background(), db.RemoveUserTxParams{UserID: member.ID, ReassignTo: recipient.ID})
	require.NoError(t, err)

	require.Equal(t, http.StatusForbidden, flowGetMe(server, access))
	require.Equal(t, http.StatusUnauthorized, flowRefresh(server, cookie).Code)
	require.Empty(t, userSessions(t, store, member.ID))
}
