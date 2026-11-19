package api

import (
	"net/http"
	"strings"
	"testing"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
)

// TestMutatingRoutesDeclarePublicCachePurge walks both routers: every mutating route must
// be in publicCachePurgeRoutes or publicCacheNoPurgeRoutes (#185), so a new write can't
// leave stale public pages behind unnoticed. Like TestGETRoutesRequireAuth for reads.
func TestMutatingRoutesDeclarePublicCachePurge(t *testing.T) {
	server := newTestServer(t, mockdb.NewMockStore(gomock.NewController(t)))

	registered := map[string]bool{}
	routes := append(server.router.Routes(), server.internalRouter.Routes()...)
	for _, route := range routes {
		if route.Method == http.MethodGet || route.Method == http.MethodHead || route.Method == http.MethodOptions {
			continue
		}
		key := route.Method + " " + route.Path
		registered[key] = true
		_, purges := publicCachePurgeRoutes[key]
		_, keeps := publicCacheNoPurgeRoutes[key]
		_, handlerPurges := publicCacheHandlerPurgeRoutes[key]
		declared := 0
		for _, in := range []bool{purges, keeps, handlerPurges} {
			if in {
				declared++
			}
		}
		require.Equal(t, 1, declared,
			"%s writes: declare it in exactly one of publicCachePurgeRoutes, publicCacheNoPurgeRoutes or publicCacheHandlerPurgeRoutes (public_cache.go): can it change what the public site shows?", key)
		// The purge middleware is on /api/v1 only: a /public write purges in its handler.
		if strings.HasPrefix(route.Path, "/public/") {
			require.False(t, purges, "%s: /public has no purge middleware; list it in publicCacheHandlerPurgeRoutes and purge in the handler", key)
		}
	}
	for _, routes := range []map[string]string{publicCachePurgeRoutes, publicCacheNoPurgeRoutes, publicCacheHandlerPurgeRoutes} {
		for key := range routes {
			require.True(t, registered[key], "%s is listed but is no longer a route", key)
		}
	}
	// The internal router has no purge middleware: none of its writes may need one.
	for _, route := range server.internalRouter.Routes() {
		_, purges := publicCachePurgeRoutes[route.Method+" "+route.Path]
		require.False(t, purges, "%s %s: the internal router doesn't purge", route.Method, route.Path)
	}
}

// TestPublicCacheRoutesArePublic: every cached route is a GET route that answers anonymous
// requests the same for everyone (/public, or listed in publicGETRoutes), so the cache can
// never hold something only a signed-in member may read.
func TestPublicCacheRoutesArePublic(t *testing.T) {
	server := newTestServer(t, mockdb.NewMockStore(gomock.NewController(t)))
	gets := map[string]bool{}
	for _, route := range server.router.Routes() {
		if route.Method == http.MethodGet {
			gets[route.Path] = true
		}
	}
	for path := range publicCacheRoutes {
		require.True(t, gets[path], "publicCacheRoutes lists %s, which is not a GET route", path)
		_, publicV1 := publicGETRoutes[path]
		require.True(t, strings.HasPrefix(path, "/public/") || publicV1, "%s is cached but isn't a public route", path)
		require.NotEqual(t, "/public/search", path, "search is never cached")
	}
}
