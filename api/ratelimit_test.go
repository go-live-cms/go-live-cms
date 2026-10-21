package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/util"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"
)

// fakeClock is a settable time source for memoryRateLimitStore.
type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time          { return c.t }
func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }

func newTestMemoryStore(perMinute int) (*memoryRateLimitStore, *fakeClock) {
	clock := &fakeClock{t: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	// One shard, so a Take on any key sweeps every key (eviction tests).
	store := newShardedMemoryRateLimitStore(perMinute, 1, rateLimitMaxKeys)
	store.now = clock.now
	return store, clock
}

// newRateLimitedRouter serves GET /ping behind limiter.perIP().
func newRateLimitedRouter(limiter *rateLimiter) *gin.Engine {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/ping", limiter.perIP(), func(c *gin.Context) { c.Status(http.StatusOK) })
	return router
}

func pingFrom(router *gin.Engine, remoteAddr string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodGet, "/ping", nil)
	request.RemoteAddr = remoteAddr
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder
}

func requireRateLimited(t *testing.T, recorder *httptest.ResponseRecorder) {
	t.Helper()
	require.Equal(t, http.StatusTooManyRequests, recorder.Code)
	retryAfter, err := strconv.Atoi(recorder.Header().Get("Retry-After"))
	require.NoError(t, err, "Retry-After must be whole seconds")
	require.GreaterOrEqual(t, retryAfter, 1)

	var body map[string]string
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	require.NotEmpty(t, body["error"], "429 must use the API's {\"error\": ...} shape")
}

func TestMemoryRateLimitStoreTake(t *testing.T) {
	store, clock := newTestMemoryStore(3)
	ctx := context.Background()

	for i := range 3 {
		ok, _, err := store.Take(ctx, "a")
		require.NoError(t, err)
		require.True(t, ok, "request %d is within the limit", i+1)
	}

	ok, retryAfter, err := store.Take(ctx, "a")
	require.NoError(t, err)
	require.False(t, ok)
	// 3/min refills one token every 20s.
	require.Equal(t, 20*time.Second, retryAfter)

	// Other keys are unaffected.
	ok, _, _ = store.Take(ctx, "b")
	require.True(t, ok)

	// Rejected requests don't push the refill further out.
	ok, retryAfter, _ = store.Take(ctx, "a")
	require.False(t, ok)
	require.Equal(t, 20*time.Second, retryAfter)

	clock.advance(20 * time.Second)
	ok, _, _ = store.Take(ctx, "a")
	require.True(t, ok, "one token refilled")
	ok, _, _ = store.Take(ctx, "a")
	require.False(t, ok)
}

func TestMemoryRateLimitStoreEvictsIdleKeys(t *testing.T) {
	store, clock := newTestMemoryStore(2)
	ctx := context.Background()

	_, _, _ = store.Take(ctx, "idle")
	_, _, _ = store.Take(ctx, "idle")
	ok, _, _ := store.Take(ctx, "idle")
	require.False(t, ok)
	require.Equal(t, 1, store.len())

	clock.advance(30 * time.Second)
	_, _, _ = store.Take(ctx, "busy")
	require.Equal(t, 2, store.len(), "nothing is idle for a full minute yet")

	// "idle" has been unused for a minute (its bucket is full again), "busy"
	// for only 30s. The next Take sweeps.
	clock.advance(30 * time.Second)
	_, _, _ = store.Take(ctx, "other")
	require.Equal(t, 2, store.len())
	require.False(t, store.has("idle"), "idle key evicted")
	require.True(t, store.has("busy"), "recently used key kept")

	// An evicted key starts with a full allowance, as it would have anyway.
	ok, _, _ = store.Take(ctx, "idle")
	require.True(t, ok)
	ok, _, _ = store.Take(ctx, "idle")
	require.True(t, ok)
}

// has reports whether key is tracked (tests).
func (s *memoryRateLimitStore) has(key string) bool {
	sh := s.shard(key)
	sh.mu.Lock()
	defer sh.mu.Unlock()
	_, ok := sh.entries[key]
	return ok
}

func TestMemoryRateLimitStoreCapsKeys(t *testing.T) {
	clock := &fakeClock{t: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	store := newShardedMemoryRateLimitStore(5, 1, 3)
	store.now = clock.now
	ctx := context.Background()

	for _, key := range []string{"a", "b", "c"} {
		_, _, _ = store.Take(ctx, key)
		clock.advance(time.Second)
	}
	_, _, _ = store.Take(ctx, "a") // a is now the most recently used

	// Full of active keys: a new one evicts the least recently used (b).
	_, _, _ = store.Take(ctx, "d")
	require.Equal(t, 3, store.len())
	require.False(t, store.has("b"))
	for _, key := range []string{"a", "c", "d"} {
		require.True(t, store.has(key), key)
	}
}

func TestMemoryRateLimitStoreShardsKeys(t *testing.T) {
	store := newMemoryRateLimitStore(5)
	ctx := context.Background()
	for i := range 1000 {
		ok, _, err := store.Take(ctx, fmt.Sprintf("key-%d", i))
		require.NoError(t, err)
		require.True(t, ok)
	}
	require.Equal(t, 1000, store.len())

	used := 0
	for _, sh := range store.shards {
		if len(sh.entries) > 0 {
			used++
		}
	}
	require.Greater(t, used, 1, "keys spread over several shards")
}

func TestClientKey(t *testing.T) {
	require.Equal(t, "192.0.2.1", clientKey("192.0.2.1"))
	require.Equal(t, "192.0.2.1", clientKey("::ffff:192.0.2.1"), "IPv4-mapped IPv6 keys as IPv4")
	require.Equal(t, "2001:db8:1:2::/64", clientKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd"))
	require.Equal(t, clientKey("2001:db8:1:2::1"), clientKey("2001:db8:1:2:ffff::9"), "same /64, same key")
	require.NotEqual(t, clientKey("2001:db8:1:2::1"), clientKey("2001:db8:1:3::1"))
	require.Equal(t, "2001:db8:1:2::/64", clientKey("2001:db8:1:2::1%eth0"), "zone ignored")
	require.Equal(t, "not-an-ip", clientKey("not-an-ip"))
}

func TestRateLimitMiddleware(t *testing.T) {
	t.Run("under the limit passes", func(t *testing.T) {
		router := newRateLimitedRouter(newRateLimiter("test", 5))
		for range 5 {
			require.Equal(t, http.StatusOK, pingFrom(router, "192.0.2.1:1234").Code)
		}
	})

	t.Run("over the limit is 429 with Retry-After", func(t *testing.T) {
		router := newRateLimitedRouter(newRateLimiter("test", 5))
		for range 5 {
			require.Equal(t, http.StatusOK, pingFrom(router, "192.0.2.1:1234").Code)
		}
		requireRateLimited(t, pingFrom(router, "192.0.2.1:1234"))
	})

	t.Run("separate client IPs don't interfere", func(t *testing.T) {
		router := newRateLimitedRouter(newRateLimiter("test", 1))
		require.Equal(t, http.StatusOK, pingFrom(router, "192.0.2.1:1234").Code)
		requireRateLimited(t, pingFrom(router, "192.0.2.1:5678")) // same IP, other port
		require.Equal(t, http.StatusOK, pingFrom(router, "192.0.2.2:1234").Code)
	})

	t.Run("IPv6 addresses in one /64 share an allowance", func(t *testing.T) {
		router := newRateLimitedRouter(newRateLimiter("test", 1))
		require.Equal(t, http.StatusOK, pingFrom(router, "[2001:db8:1:2::1]:1234").Code)
		requireRateLimited(t, pingFrom(router, "[2001:db8:1:2::abcd]:1234"))
		require.Equal(t, http.StatusOK, pingFrom(router, "[2001:db8:1:3::1]:1234").Code)
	})

	t.Run("disabled limiter lets everything through", func(t *testing.T) {
		require.Nil(t, newRateLimiter("test", 0))
		router := newRateLimitedRouter(nil)
		for range 50 {
			require.Equal(t, http.StatusOK, pingFrom(router, "192.0.2.1:1234").Code)
		}
	})

	t.Run("exempt IPs skip the limit", func(t *testing.T) {
		exempt, err := parsePrefixes([]string{"10.0.0.0/8", "192.0.2.9"})
		require.NoError(t, err)
		gin.SetMode(gin.TestMode)
		router := gin.New()
		router.GET("/ping", newRateLimiter("test", 1).perIP(exempt...), func(c *gin.Context) { c.Status(http.StatusOK) })

		for range 3 {
			require.Equal(t, http.StatusOK, pingFrom(router, "10.1.2.3:1234").Code)
			require.Equal(t, http.StatusOK, pingFrom(router, "192.0.2.9:1234").Code)
		}
		require.Equal(t, http.StatusOK, pingFrom(router, "192.0.2.1:1234").Code)
		requireRateLimited(t, pingFrom(router, "192.0.2.1:1234"))
	})

	t.Run("store errors fail open", func(t *testing.T) {
		router := newRateLimitedRouter(&rateLimiter{name: "test", store: failingStore{}})
		require.Equal(t, http.StatusOK, pingFrom(router, "192.0.2.1:1234").Code)
	})
}

type failingStore struct{}

func (failingStore) Take(context.Context, string) (bool, time.Duration, error) {
	return false, 0, errors.New("store down")
}

func TestParsePrefixes(t *testing.T) {
	prefixes, err := parsePrefixes([]string{"10.0.0.0/8", "192.0.2.7", "2001:db8::/32"})
	require.NoError(t, err)
	require.True(t, ipInPrefixes("10.9.9.9", prefixes))
	require.True(t, ipInPrefixes("192.0.2.7", prefixes))
	require.True(t, ipInPrefixes("::ffff:192.0.2.7", prefixes), "IPv4-mapped IPv6 matches as IPv4")
	require.True(t, ipInPrefixes("2001:db8::1", prefixes))
	require.False(t, ipInPrefixes("192.0.2.8", prefixes))
	require.False(t, ipInPrefixes("not-an-ip", prefixes))

	_, err = parsePrefixes([]string{"10.0.0.0/33"})
	require.Error(t, err)
	_, err = parsePrefixes([]string{"example.com"})
	require.Error(t, err)
	_, err = parsePrefixes([]string{"fe80::1%eth0"})
	require.Error(t, err, "zoned addresses can't match a client IP")
}

func TestNewServerRejectsInvalidRateLimitConfig(t *testing.T) {
	// Errors, not panics, including values only gin's parser rejects.
	for _, proxies := range []string{"not-an-ip", "fe80::1%eth0"} {
		config := newTestConfig(t)
		config.TrustedProxies = proxies
		_, err := NewServer(config, mockdb.NewMockStore(gomock.NewController(t)))
		require.ErrorContains(t, err, "TRUSTED_PROXIES", proxies)
	}

	config := newTestConfig(t)
	config.RateLimitExemptCIDRs = "10.0.0.0/99"
	_, err := NewServer(config, mockdb.NewMockStore(gomock.NewController(t)))
	require.ErrorContains(t, err, "RATE_LIMIT_EXEMPT_CIDRS")
}

// newRateLimitedTestServer is newTestServer with the given limits applied.
func newRateLimitedTestServer(t *testing.T, store db.Store, configure func(*util.Config)) *Server {
	gin.SetMode(gin.TestMode)
	config := newTestConfig(t)
	configure(&config)
	server, err := NewServer(config, store)
	require.NoError(t, err)
	return server
}

func loginRequest(t *testing.T, remoteAddr, forwardedFor string) *http.Request {
	return loginRequestAs(t, "nobody", remoteAddr, forwardedFor)
}

func loginRequestAs(t *testing.T, username, remoteAddr, forwardedFor string) *http.Request {
	body, err := json.Marshal(gin.H{"username": username, "password": "wrong-password"})
	require.NoError(t, err)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.RemoteAddr = remoteAddr
	if forwardedFor != "" {
		request.Header.Set("X-Forwarded-For", forwardedFor)
	}
	return request
}

func TestLoginRateLimit(t *testing.T) {
	const limit = 10

	// Every attempt that reaches the handler is a failed login.
	expectFailedLogins := func(store *mockdb.MockStore, times int) {
		store.EXPECT().
			GetUserByUsername(gomock.Any(), gomock.Any()).
			Times(times).
			Return(db.User{}, sql.ErrNoRows)
	}

	t.Run("11th attempt in a minute is 429 and never reaches the handler", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		expectFailedLogins(store, limit) // the 11th must not hit the DB
		server := newRateLimitedTestServer(t, store, func(c *util.Config) { c.RateLimitLoginPerMinute = limit })

		for i := range limit {
			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, loginRequest(t, "198.51.100.1:4000", ""))
			require.Equal(t, http.StatusUnauthorized, recorder.Code, "attempt %d", i+1)
		}
		recorder := httptest.NewRecorder()
		server.router.ServeHTTP(recorder, loginRequest(t, "198.51.100.1:4000", ""))
		requireRateLimited(t, recorder)

		// Another client still gets through.
		expectFailedLogins(store, 1)
		recorder = httptest.NewRecorder()
		server.router.ServeHTTP(recorder, loginRequest(t, "198.51.100.2:4000", ""))
		require.Equal(t, http.StatusUnauthorized, recorder.Code)
	})

	t.Run("X-Forwarded-For from an untrusted peer is ignored", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		expectFailedLogins(store, limit)
		server := newRateLimitedTestServer(t, store, func(c *util.Config) { c.RateLimitLoginPerMinute = limit })

		// A fresh spoofed address per request must not buy fresh allowances.
		for i := range limit {
			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, loginRequest(t, "198.51.100.1:4000", fmt.Sprintf("203.0.113.%d", i)))
			require.Equal(t, http.StatusUnauthorized, recorder.Code)
		}
		recorder := httptest.NewRecorder()
		server.router.ServeHTTP(recorder, loginRequest(t, "198.51.100.1:4000", "203.0.113.200"))
		requireRateLimited(t, recorder)
	})

	t.Run("X-Forwarded-For from a trusted proxy keys by the real client", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		expectFailedLogins(store, limit+1)
		server := newRateLimitedTestServer(t, store, func(c *util.Config) {
			c.RateLimitLoginPerMinute = limit
			c.TrustedProxies = "10.0.0.0/8"
		})

		const proxy = "10.0.0.5:4000"
		for range limit {
			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, loginRequest(t, proxy, "203.0.113.1"))
			require.Equal(t, http.StatusUnauthorized, recorder.Code)
		}
		recorder := httptest.NewRecorder()
		server.router.ServeHTTP(recorder, loginRequest(t, proxy, "203.0.113.1"))
		requireRateLimited(t, recorder)

		// A different client behind the same proxy has its own allowance.
		recorder = httptest.NewRecorder()
		server.router.ServeHTTP(recorder, loginRequest(t, proxy, "203.0.113.2"))
		require.Equal(t, http.StatusUnauthorized, recorder.Code)
	})

	t.Run("one username locked out doesn't block others from the same IP", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		expectFailedLogins(store, limit+1)
		server := newRateLimitedTestServer(t, store, func(c *util.Config) {
			c.RateLimitLoginPerMinute = limit
			c.RateLimitLoginIPPerMinute = 100
		})

		const sharedIP = "198.51.100.1:4000"
		for range limit {
			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, loginRequestAs(t, "victim", sharedIP, ""))
			require.Equal(t, http.StatusUnauthorized, recorder.Code)
		}
		recorder := httptest.NewRecorder()
		server.router.ServeHTTP(recorder, loginRequestAs(t, "victim", sharedIP, ""))
		requireRateLimited(t, recorder)

		recorder = httptest.NewRecorder()
		server.router.ServeHTTP(recorder, loginRequestAs(t, "colleague", sharedIP, ""))
		require.Equal(t, http.StatusUnauthorized, recorder.Code, "another user behind the same IP can still log in")
	})

	t.Run("per-IP cap limits spraying across usernames", func(t *testing.T) {
		const ipLimit = 5
		store := mockdb.NewMockStore(gomock.NewController(t))
		expectFailedLogins(store, ipLimit)
		server := newRateLimitedTestServer(t, store, func(c *util.Config) {
			c.RateLimitLoginPerMinute = limit
			c.RateLimitLoginIPPerMinute = ipLimit
		})

		for i := range ipLimit {
			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, loginRequestAs(t, fmt.Sprintf("user%d", i), "198.51.100.1:4000", ""))
			require.Equal(t, http.StatusUnauthorized, recorder.Code)
		}
		recorder := httptest.NewRecorder()
		server.router.ServeHTTP(recorder, loginRequestAs(t, "user-next", "198.51.100.1:4000", ""))
		requireRateLimited(t, recorder)
	})
}

func TestGeneralRateLimitAppliesToAPIRoutes(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newRateLimitedTestServer(t, store, func(c *util.Config) { c.RateLimitGeneralPerMinute = 2 })

	get := func(path string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		request.RemoteAddr = "198.51.100.1:4000"
		recorder := httptest.NewRecorder()
		server.router.ServeHTTP(recorder, request)
		return recorder
	}

	// /users/me without a token is a 401 that never touches the store.
	require.Equal(t, http.StatusUnauthorized, get("/api/v1/users/me").Code)
	require.Equal(t, http.StatusUnauthorized, get("/api/v1/users/me").Code)
	requireRateLimited(t, get("/api/v1/users/me"))

	// Health checks aren't limited.
	require.Equal(t, http.StatusOK, get("/health").Code)
}

func TestSelfPasswordChangeRateLimit(t *testing.T) {
	const limit = 3
	user := randomUserNew()
	hashed, err := util.HashPassword("current-password")
	require.NoError(t, err)
	user.HashedPassword = hashed

	store := mockdb.NewMockStore(gomock.NewController(t))
	stubRoleLookup(store, user)
	server := newRateLimitedTestServer(t, store, func(c *util.Config) { c.RateLimitPasswordChangePerMinute = limit })

	attempt := func(remoteAddr string) *httptest.ResponseRecorder {
		body, err := json.Marshal(gin.H{"password": "new-password", "current_password": "guess"})
		require.NoError(t, err)
		request := httptest.NewRequest(http.MethodPut, fmt.Sprintf("/api/v1/users/%d", user.ID), bytes.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.RemoteAddr = remoteAddr
		addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
		recorder := httptest.NewRecorder()
		server.router.ServeHTTP(recorder, request)
		return recorder
	}

	const thief, owner = "198.51.100.1:4000", "198.51.100.99:4000"
	for range limit {
		require.Equal(t, http.StatusForbidden, attempt(thief).Code, "wrong current password")
	}
	requireRateLimited(t, attempt(thief))

	// Keyed by user and client: the thief's guesses don't use up the owner's
	// allowance, so the owner can still change the password.
	require.Equal(t, http.StatusForbidden, attempt(owner).Code, "reaches the password check")
}
