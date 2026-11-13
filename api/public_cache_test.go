package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"

	"github.com/go-live-cms/go-live-cms/cache"
	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Public read cache (#185, public_cache.go) on a mock store: hits and misses, keys, what is
// never cached, purges and a failing Valkey. public_cache_db_test.go checks the purge on
// every publish path against the real database.

// withMiniredis gives server a real Valkey protocol cache (miniredis) and returns it.
func withMiniredis(t *testing.T, server *Server) *miniredis.Miniredis {
	t.Helper()
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr(), DialerRetries: 1})
	t.Cleanup(func() { _ = client.Close() })
	server.SetCache(cache.NewRedisFromClient(client))
	return mr
}

// cacheGet sends an anonymous GET (header pairs optional) and returns the recorder.
func cacheGet(t *testing.T, server *Server, path string, header ...string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, path, nil)
	for i := 0; i+1 < len(header); i += 2 {
		request.Header.Set(header[i], header[i+1])
	}
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	return recorder
}

// publicCacheEntries counts the stored responses (not the generation key).
func publicCacheEntries(mr *miniredis.Miniredis) int {
	n := 0
	for _, key := range mr.Keys() {
		if strings.HasPrefix(key, publicCacheNamespace+":") && key != publicCacheNamespace+":gen" {
			n++
		}
	}
	return n
}

func testSettingsRow() db.Setting {
	return db.Setting{SiteTitle: sql.NullString{String: "Cached site", Valid: true}, PostsPerPage: sql.NullInt32{Int32: 10, Valid: true}, PostUrlStructure: "slug"}
}

func TestPublicCacheIsOffByDefault(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	store.EXPECT().GetSettings(gomock.Any()).Return(testSettingsRow(), nil).Times(2)
	server := newTestServer(t, store)

	require.IsType(t, cache.Noop{}, server.Cache(), "no REDIS_URL: the no-op cache")
	for i := 0; i < 2; i++ {
		recorder := cacheGet(t, server, "/api/v1/settings")
		require.Equal(t, http.StatusOK, recorder.Code)
		require.Empty(t, recorder.Header().Get(publicCacheHeader), "the no-op cache does nothing at all")
	}
	// Purging is a no-op too.
	server.purgePublicCache(context.Background(), "test")
}

func TestNewServerRejectsBadRedisURL(t *testing.T) {
	config := newTestConfig(t)
	config.RedisURL = "http://valkey:6379"
	_, err := NewServer(config, mockdb.NewMockStore(gomock.NewController(t)))
	require.ErrorContains(t, err, "REDIS_URL")
}

func TestPublicCacheMissThenHit(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	store.EXPECT().GetSettings(gomock.Any()).Return(testSettingsRow(), nil).Times(1)
	server := newTestServer(t, store)
	mr := withMiniredis(t, server)

	first := cacheGet(t, server, "/api/v1/settings")
	require.Equal(t, http.StatusOK, first.Code)
	require.Equal(t, "MISS", first.Header().Get(publicCacheHeader))
	require.Equal(t, 1, publicCacheEntries(mr))

	second := cacheGet(t, server, "/api/v1/settings")
	require.Equal(t, http.StatusOK, second.Code)
	require.Equal(t, "HIT", second.Header().Get(publicCacheHeader))
	require.Equal(t, first.Body.String(), second.Body.String())
	require.Equal(t, first.Header().Get("Content-Type"), second.Header().Get("Content-Type"))

	// Entries expire on their own.
	for _, key := range mr.Keys() {
		if key != publicCacheNamespace+":gen" {
			require.Equal(t, publicCacheTTL, mr.TTL(key))
		}
	}
}

func TestPublicCachePurgeMakesTheNextReadAMiss(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	row := testSettingsRow()
	store.EXPECT().GetSettings(gomock.Any()).DoAndReturn(func(context.Context) (db.Setting, error) { return row, nil }).Times(2)
	server := newTestServer(t, store)
	withMiniredis(t, server)

	require.Equal(t, "MISS", cacheGet(t, server, "/api/v1/settings").Header().Get(publicCacheHeader))
	require.Equal(t, "HIT", cacheGet(t, server, "/api/v1/settings").Header().Get(publicCacheHeader))

	row.SiteTitle = sql.NullString{String: "Renamed site", Valid: true}
	server.purgePublicCache(context.Background(), "test")
	recorder := cacheGet(t, server, "/api/v1/settings")
	require.Equal(t, "MISS", recorder.Header().Get(publicCacheHeader))
	require.Contains(t, recorder.Body.String(), "Renamed site")
}

// An admin's read (any Authorization header) never comes from or goes into the cache.
func TestPublicCacheBypassedWithAuthorization(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	store.EXPECT().GetSettings(gomock.Any()).Return(testSettingsRow(), nil).Times(3)
	server := newTestServer(t, store)
	mr := withMiniredis(t, server)

	for i := 0; i < 2; i++ {
		recorder := cacheGet(t, server, "/api/v1/settings", "Authorization", "Bearer whatever")
		require.Equal(t, http.StatusOK, recorder.Code)
		require.Empty(t, recorder.Header().Get(publicCacheHeader))
	}
	require.Zero(t, publicCacheEntries(mr))
	// An anonymous read after them is a miss: nothing was stored for the admin.
	require.Equal(t, "MISS", cacheGet(t, server, "/api/v1/settings").Header().Get(publicCacheHeader))
}

// Errors and the 404s of routes that don't allow it are never stored; the front page's
// 404 (no front page: the normal case) is, and replays with this request's id.
func TestPublicCacheStoresOnlyCacheableAnswers(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	server := newTestServer(t, store)
	mr := withMiniredis(t, server)

	store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{}, errors.New("db down")).Times(2)
	for i := 0; i < 2; i++ {
		require.Equal(t, http.StatusInternalServerError, cacheGet(t, server, "/api/v1/settings").Code)
	}
	require.Zero(t, publicCacheEntries(mr))

	// A missing post: 404, not stored (a post published later must appear at once).
	store.EXPECT().GetPost(gomock.Any(), int64(42)).Return(db.Post{}, sql.ErrNoRows).Times(2)
	for i := 0; i < 2; i++ {
		recorder := cacheGet(t, server, "/public/posts/42")
		require.Equal(t, http.StatusNotFound, recorder.Code)
		require.Equal(t, "MISS", recorder.Header().Get(publicCacheHeader))
	}
	require.Zero(t, publicCacheEntries(mr))

	store.EXPECT().GetPublicFrontPage(gomock.Any()).Return(db.Post{}, sql.ErrNoRows).Times(1)
	first := cacheGet(t, server, "/public/front-page", requestIDHeader, "first-request-id")
	second := cacheGet(t, server, "/public/front-page", requestIDHeader, "second-request-id")
	require.Equal(t, http.StatusNotFound, first.Code)
	require.Equal(t, http.StatusNotFound, second.Code)
	require.Equal(t, "HIT", second.Header().Get(publicCacheHeader))
	var a, b map[string]any
	require.NoError(t, json.Unmarshal(first.Body.Bytes(), &a))
	require.NoError(t, json.Unmarshal(second.Body.Bytes(), &b))
	require.Equal(t, "no_front_page", b["code"])
	require.NotEmpty(t, b[requestIDKey])
	require.NotEqual(t, a[requestIDKey], b[requestIDKey], "a replayed error carries its own request id")
	require.Equal(t, 1, publicCacheEntries(mr))
}

// Routes not in publicCacheRoutes are never cached: search, redirects, the admin's posts.
func TestPublicCacheOnlyListedRoutes(t *testing.T) {
	for _, path := range []string{"/public/search", "/public/redirects", "/api/v1/posts", "/api/v1/posts/:id", "/api/v1/posts/:id/blocks"} {
		_, listed := publicCacheRoutes[path]
		require.False(t, listed, path)
	}
}

func TestPublicCacheKeySuffix(t *testing.T) {
	key := func(target string) string {
		return publicCacheKeySuffix(httptest.NewRequest(http.MethodGet, target, nil))
	}
	require.Equal(t, "GET /public/posts?limit=5&type=post", key("/public/posts?type=post&limit=5"))
	require.Equal(t, key("/public/posts?type=post&limit=5"), key("/public/posts?limit=5&type=post"), "query order doesn't matter")
	require.NotEqual(t, key("/public/posts?type=post"), key("/public/posts?type=page"))
	require.NotEqual(t, key("/public/posts/type/post?page=1"), key("/public/posts/type/post?page=2"))
	require.NotEqual(t, key("/public/posts/slug/a%2Fb"), key("/public/posts/slug/a/b"), "the escaped path")
	require.NotEqual(t, key("/public/menus/primary"), key("/public/menus/footer"))
	require.Equal(t, "GET /public/front-page", key("/public/front-page"))

	long := key("/public/posts?type=" + strings.Repeat("x", 1000))
	require.True(t, strings.HasPrefix(long, "h:"))
	require.Len(t, long, 2+64)
	require.NotEqual(t, long, key("/public/posts?type="+strings.Repeat("y", 1000)))
}

func TestPublicCacheEntryEncoding(t *testing.T) {
	entry := &publicCacheEntry{status: 200, contentType: "application/json; charset=utf-8", body: []byte("{\"a\":\"x\\ny\"}\n")}
	decoded, ok := decodePublicCacheEntry(entry.encode())
	require.True(t, ok)
	require.Equal(t, entry, decoded)

	for _, bad := range []string{"", "200", "200\napplication/json", "abc\nx\n{}", "99\nx\n{}", "600\nx\n{}"} {
		_, ok := decodePublicCacheEntry([]byte(bad))
		require.False(t, ok, bad)
	}
}

// A corrupt stored value is a miss, not an error page.
func TestPublicCacheIgnoresCorruptEntry(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	store.EXPECT().GetSettings(gomock.Any()).Return(testSettingsRow(), nil).Times(2)
	server := newTestServer(t, store)
	mr := withMiniredis(t, server)

	require.Equal(t, "MISS", cacheGet(t, server, "/api/v1/settings").Header().Get(publicCacheHeader))
	for _, key := range mr.Keys() {
		if key != publicCacheNamespace+":gen" {
			require.NoError(t, mr.Set(key, "garbage"))
		}
	}
	recorder := cacheGet(t, server, "/api/v1/settings")
	require.Equal(t, http.StatusOK, recorder.Code)
	require.Equal(t, "MISS", recorder.Header().Get(publicCacheHeader))
}

func TestPublicCacheRecorderRefusals(t *testing.T) {
	newRecorder := func(status int, header http.Header, body []byte) *publicCacheRecorder {
		gin.SetMode(gin.TestMode)
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		for k, v := range header {
			c.Writer.Header()[k] = v
		}
		c.Status(status)
		w := &publicCacheRecorder{ResponseWriter: c.Writer}
		_, _ = w.Write(body)
		return w
	}
	_, ok := newRecorder(200, nil, []byte("{}")).entry(publicCacheRoute{})
	require.True(t, ok)
	_, ok = newRecorder(404, nil, []byte("{}")).entry(publicCacheRoute{})
	require.False(t, ok)
	_, ok = newRecorder(404, nil, []byte("{}")).entry(publicCacheRoute{notFound: true})
	require.True(t, ok)
	_, ok = newRecorder(500, nil, []byte("{}")).entry(publicCacheRoute{notFound: true})
	require.False(t, ok)
	_, ok = newRecorder(200, http.Header{"Set-Cookie": {"a=b"}}, []byte("{}")).entry(publicCacheRoute{})
	require.False(t, ok, "never store a response that sets a cookie")
	_, ok = newRecorder(200, http.Header{"Cache-Control": {"no-store"}}, []byte("{}")).entry(publicCacheRoute{})
	require.False(t, ok)
	big := newRecorder(200, nil, bytes.Repeat([]byte("x"), publicCacheMaxBody+1))
	_, ok = big.entry(publicCacheRoute{})
	require.False(t, ok, "too large")

	// Written in pieces past the cap: refused too, and the body still went out whole.
	pieces := newRecorder(200, nil, bytes.Repeat([]byte("x"), publicCacheMaxBody))
	n, err := pieces.WriteString("tail")
	require.NoError(t, err)
	require.Equal(t, 4, n)
	_, ok = pieces.entry(publicCacheRoute{})
	require.False(t, ok)
}

// Valkey down: every read goes to the database (BYPASS), the page still answers, and a
// purge is only logged.
func TestPublicCacheValkeyDown(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	store.EXPECT().GetSettings(gomock.Any()).Return(testSettingsRow(), nil).Times(2)
	server := newTestServer(t, store)
	mr := withMiniredis(t, server)
	mr.Close()

	for i := 0; i < 2; i++ {
		recorder := cacheGet(t, server, "/api/v1/settings")
		require.Equal(t, http.StatusOK, recorder.Code)
		require.Equal(t, "BYPASS", recorder.Header().Get(publicCacheHeader))
	}
	server.purgePublicCache(context.Background(), "test") // must not panic or block
}

// Valkey failing only after the generation was read: the read error is a miss, the
// answer still comes from the database.
func TestPublicCacheReadErrorIsAMiss(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	store.EXPECT().GetSettings(gomock.Any()).Return(testSettingsRow(), nil).Times(1)
	server := newTestServer(t, store)
	_, c := miniredisCache(t)
	server.SetCache(&failingGets{Cache: c})

	recorder := cacheGet(t, server, "/api/v1/settings")
	require.Equal(t, http.StatusOK, recorder.Code)
	require.Equal(t, "MISS", recorder.Header().Get(publicCacheHeader))
}

func miniredisCache(t *testing.T) (*miniredis.Miniredis, cache.Cache) {
	t.Helper()
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr(), DialerRetries: 1})
	t.Cleanup(func() { _ = client.Close() })
	return mr, cache.NewRedisFromClient(client)
}

// failingGets fails every Get but the generation's.
type failingGets struct{ cache.Cache }

func (f *failingGets) Get(ctx context.Context, key string) ([]byte, error) {
	if key == publicCacheNamespace+":gen" {
		return f.Cache.Get(ctx, key)
	}
	return nil, errors.New("read timeout")
}

// Concurrent misses for one key run the handler once (singleflight); the others get
// its answer.
func TestPublicCacheConcurrentMissesShareOneRead(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	release := make(chan struct{})
	store.EXPECT().GetSettings(gomock.Any()).DoAndReturn(func(context.Context) (db.Setting, error) {
		<-release
		return testSettingsRow(), nil
	}).Times(1)
	server := newTestServer(t, store)
	withMiniredis(t, server)

	const readers = 8
	var wg sync.WaitGroup
	codes := make(chan int, readers)
	for i := 0; i < readers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes <- cacheGet(t, server, "/api/v1/settings").Code
		}()
	}
	time.Sleep(200 * time.Millisecond) // every reader is past its cache read and waiting
	close(release)
	wg.Wait()
	close(codes)
	for code := range codes {
		require.Equal(t, http.StatusOK, code)
	}
}

// A follower whose leader answered something not cacheable runs its own handler.
func TestPublicCacheFollowerOfUncacheableRunsItself(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	release := make(chan struct{})
	first := true
	var mu sync.Mutex
	store.EXPECT().GetSettings(gomock.Any()).DoAndReturn(func(context.Context) (db.Setting, error) {
		mu.Lock()
		leading := first
		first = false
		mu.Unlock()
		if leading {
			<-release
			return db.Setting{}, errors.New("db hiccup")
		}
		return testSettingsRow(), nil
	}).Times(2)
	server := newTestServer(t, store)
	withMiniredis(t, server)

	results := make(chan int, 2)
	go func() { results <- cacheGet(t, server, "/api/v1/settings").Code }()
	time.Sleep(100 * time.Millisecond)
	go func() { results <- cacheGet(t, server, "/api/v1/settings").Code }()
	time.Sleep(100 * time.Millisecond)
	close(release)
	got := []int{<-results, <-results}
	require.ElementsMatch(t, []int{http.StatusInternalServerError, http.StatusOK}, got)
}

// flakyCache fails every operation while fail is set.
type flakyCache struct {
	cache.Cache
	fail atomic.Bool
}

func (f *flakyCache) err() error { return errors.New("valkey unreachable") }

func (f *flakyCache) Get(ctx context.Context, key string) ([]byte, error) {
	if f.fail.Load() {
		return nil, f.err()
	}
	return f.Cache.Get(ctx, key)
}

func (f *flakyCache) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	if f.fail.Load() {
		return f.err()
	}
	return f.Cache.Set(ctx, key, value, ttl)
}

func (f *flakyCache) SetNX(ctx context.Context, key string, value []byte, ttl time.Duration) (bool, error) {
	if f.fail.Load() {
		return false, f.err()
	}
	return f.Cache.SetNX(ctx, key, value, ttl)
}

// A purge missed while Valkey was out of reach: reads skip the cache meanwhile, and the
// first read once it answers again purges, so the entry stored before the outage (stale
// now) is never served.
func TestPublicCacheRecoversWithAPurge(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	row := testSettingsRow()
	store.EXPECT().GetSettings(gomock.Any()).DoAndReturn(func(context.Context) (db.Setting, error) { return row, nil }).AnyTimes()
	server := newTestServer(t, store)
	_, c := miniredisCache(t)
	flaky := &flakyCache{Cache: c}
	server.SetCache(flaky)

	require.Equal(t, "MISS", cacheGet(t, server, "/api/v1/settings").Header().Get(publicCacheHeader))
	require.Equal(t, "HIT", cacheGet(t, server, "/api/v1/settings").Header().Get(publicCacheHeader))

	flaky.fail.Store(true)
	row.SiteTitle = sql.NullString{String: "Changed during the outage", Valid: true}
	server.purgePublicCache(context.Background(), "test") // fails: logged, not returned
	flaky.fail.Store(false)

	// Within the back-off: Valkey isn't asked at all.
	recorder := cacheGet(t, server, "/api/v1/settings")
	require.Equal(t, "BYPASS", recorder.Header().Get(publicCacheHeader))
	require.Contains(t, recorder.Body.String(), "Changed during the outage")

	// After it: purge first, then the fresh answer.
	server.publicCache.skipUntil.Store(0)
	recorder = cacheGet(t, server, "/api/v1/settings")
	require.Equal(t, "MISS", recorder.Header().Get(publicCacheHeader), "the pre-outage entry must not be served")
	require.Contains(t, recorder.Body.String(), "Changed during the outage")
	require.Equal(t, "HIT", cacheGet(t, server, "/api/v1/settings").Header().Get(publicCacheHeader))

	// Still failing when the back-off ends: bypass again, and keep trying later.
	flaky.fail.Store(true)
	server.purgePublicCache(context.Background(), "test")
	server.publicCache.skipUntil.Store(0)
	require.Equal(t, "BYPASS", cacheGet(t, server, "/api/v1/settings").Header().Get(publicCacheHeader))
	require.True(t, server.publicCache.unhealthy.Load())
}
