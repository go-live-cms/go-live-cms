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
		// Comment writes purge themselves by outcome (#523, discussion_purge.go).
		_, self := publicCacheDiscussionRoutes[key]
		declared := 0
		for _, in := range []bool{purges, keeps, self} {
			if in {
				declared++
			}
		}
		require.Equal(t, 1, declared,
			"%s writes: it must be in exactly one of publicCachePurgeRoutes, publicCacheNoPurgeRoutes (public_cache.go) or publicCacheDiscussionRoutes (discussion_purge.go): can it change what the public site shows?", key)
	}
	for key := range publicCacheDiscussionRoutes {
		require.True(t, registered[key], "publicCacheDiscussionRoutes lists %s, which is no longer a route", key)
	}
	for key := range publicCachePurgeRoutes {
		require.True(t, registered[key], "publicCachePurgeRoutes lists %s, which is no longer a route", key)
	}
	for key := range publicCacheNoPurgeRoutes {
		require.True(t, registered[key], "publicCacheNoPurgeRoutes lists %s, which is no longer a route", key)
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
