package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Until #393 the post read routes were registered without authMiddleware and
// served the admin's working copy, drafts included, to anyone: nothing failed
// when a read route went in without it. TestGETRoutesRequireAuth walks the
// router so a new one can't: outside /public, a GET route answers 401 without
// a token unless it is listed here, with the reason it may be public.
//
// /public is published data only (TestPublicNeverServesDrafts checks that).
var publicGETRoutes = map[string]string{
	"/health":            "liveness",
	"/readyz":            "readiness",
	"/api/v1/health":     "liveness, through the web /api proxy",
	"/uploads/*filepath": "the uploaded files published posts embed",

	"/api/v1/settings":                "site title, tagline, language, time zone, URL structure: the public site's config (#330)",
	"/api/v1/extension-settings":      "theme options the public theme reads (ThemeSettingsImpl)",
	"/api/v1/extension-settings/:key": "theme options the public theme reads (ThemeSettingsImpl)",

	"/api/v1/themes":              "the installed themes: the public site picks its layouts from the active one",
	"/api/v1/themes/active":       "the active theme and its settings, read on every public request",
	"/api/v1/themes/:id":          "theme config",
	"/api/v1/themes/:id/settings": "theme config",

	"/api/v1/post-types":       "which types have public pages (the post route and the sitemap)",
	"/api/v1/post-types/:name": "post type config",

	"/api/v1/taxonomy/types":             "taxonomy config: term archive routes and labels (#348)",
	"/api/v1/taxonomy/types/:name":       "taxonomy config",
	"/api/v1/taxonomy/types/:name/terms": "term names and slugs, which published posts show",
	"/api/v1/taxonomy/terms/popular":     "the search page's popular categories (no posts in the response)",
	"/api/v1/taxonomy/terms/search":      "term lookup (no posts in the response)",
	"/api/v1/taxonomy/terms/slug/:slug":  "term lookup (no posts in the response)",
	"/api/v1/taxonomy/terms/:id":         "term lookup (no posts in the response)",
}

func TestGETRoutesRequireAuth(t *testing.T) {
	// No expectations: an anonymous request must not get as far as the store.
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)

	registered := map[string]bool{}
	for _, route := range server.router.Routes() {
		if route.Method != http.MethodGet && route.Method != http.MethodHead {
			continue
		}
		registered[route.Path] = true
		if strings.HasPrefix(route.Path, "/public/") {
			continue
		}
		if _, public := publicGETRoutes[route.Path]; public {
			continue
		}

		t.Run(route.Method+" "+route.Path, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, httptest.NewRequest(route.Method, routeExample(route.Path), nil))
			require.Equal(t, http.StatusUnauthorized, recorder.Code,
				"%s %s answers without a token: add authMiddleware (and a role check), or list it in publicGETRoutes with the reason it may be public",
				route.Method, route.Path)
		})
	}

	for path := range publicGETRoutes {
		require.True(t, registered[path], "publicGETRoutes lists %s, which is no longer a GET route", path)
	}
}

// commentRoutes are the block comment routes (#192), every method: none is public, and
// TestCommentRoutesRequireAuth fails when a comment route is added without being listed
// here (so its rule gets a look) or answers an anonymous request.
var commentRoutes = map[string]string{
	"GET /api/v1/posts/:id/comments":                              "canReadPost",
	"POST /api/v1/posts/:id/comments":                             "canCommentOnPost",
	"PUT /api/v1/posts/:id/comments/:comment_id":                  "canEditComment: the author",
	"DELETE /api/v1/posts/:id/comments/:comment_id":               "canDeleteComment: the author or a moderator",
	"POST /api/v1/posts/:id/comment-threads/:thread_id/replies":   "canCommentOnPost",
	"POST /api/v1/posts/:id/comment-threads/:thread_id/resolve":   "canResolveCommentThread",
	"POST /api/v1/posts/:id/comment-threads/:thread_id/unresolve": "canResolveCommentThread",
}

func TestCommentRoutesRequireAuth(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)

	registered := map[string]bool{}
	for _, route := range server.router.Routes() {
		if !strings.Contains(route.Path, "comment") {
			continue
		}
		key := route.Method + " " + route.Path
		registered[key] = true
		_, listed := commentRoutes[key]
		require.True(t, listed, "%s is a comment route missing from commentRoutes", key)
		require.False(t, strings.HasPrefix(route.Path, "/public"), "comments never reach the public site: %s", key)

		t.Run(key, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, httptest.NewRequest(route.Method, routeExample(route.Path), strings.NewReader(`{"block_id":"blk-anon-000001","body":"x"}`)))
			require.Equal(t, http.StatusUnauthorized, recorder.Code, "%s answers without a token", key)
		})
	}
	for key := range commentRoutes {
		require.True(t, registered[key], "commentRoutes lists %s, which is no longer a route", key)
	}
}

// blockEditRoutes are the per-block "Last edited by" routes (#328), every method:
// attribution never reaches the public site, and the collab server's store is its only
// writer, so a write route here would be a bug. TestBlockEditRoutesRequireAuth fails
// when one is added without being listed (so its rule gets a look), answers an
// anonymous request, or is public.
var blockEditRoutes = map[string]string{
	"GET /api/v1/posts/:id/block-edits": "canReadPost",
}

func TestBlockEditRoutesRequireAuth(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)

	registered := map[string]bool{}
	for _, route := range server.router.Routes() {
		if !strings.Contains(route.Path, "block-edit") {
			continue
		}
		key := route.Method + " " + route.Path
		registered[key] = true
		_, listed := blockEditRoutes[key]
		require.True(t, listed, "%s is a block edit route missing from blockEditRoutes", key)
		require.False(t, strings.HasPrefix(route.Path, "/public"), "attribution never reaches the public site: %s", key)
		require.Equal(t, http.MethodGet, route.Method, "only the collab store writes attribution: %s", key)

		t.Run(key, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, httptest.NewRequest(route.Method, routeExample(route.Path), nil))
			require.Equal(t, http.StatusUnauthorized, recorder.Code, "%s answers without a token", key)
		})
	}
	for key := range blockEditRoutes {
		require.True(t, registered[key], "blockEditRoutes lists %s, which is no longer a route", key)
	}
}

// embedRoutes are the embed routes (#425), every method. Resolving makes the API fetch from
// a provider, so TestEmbedRoutesRequireRole fails when one is added without being listed
// here (so its rule gets a look), or answers an anonymous request or a contributor.
var embedRoutes = map[string]string{
	"POST /api/v1/embeds/resolve": "requireContentEditor: editors and admins",
}

func TestEmbedRoutesRequireRole(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)
	contributor := db.User{ID: 41, Username: "contrib", Role: RoleContributor}
	store.EXPECT().GetUser(gomock.Any(), contributor.ID).AnyTimes().Return(contributor, nil)

	registered := map[string]bool{}
	for _, route := range server.router.Routes() {
		if !strings.Contains(route.Path, "/embeds") {
			continue
		}
		key := route.Method + " " + route.Path
		registered[key] = true
		_, listed := embedRoutes[key]
		require.True(t, listed, "%s is an embed route missing from embedRoutes", key)
		require.False(t, strings.HasPrefix(route.Path, "/public"), "resolving is never public: %s", key)

		t.Run(key, func(t *testing.T) {
			body := `{"url":"https://youtu.be/dQw4w9WgXcQ"}`
			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, httptest.NewRequest(route.Method, routeExample(route.Path), strings.NewReader(body)))
			require.Equal(t, http.StatusUnauthorized, recorder.Code, "%s answers without a token", key)

			request := httptest.NewRequest(route.Method, routeExample(route.Path), strings.NewReader(body))
			addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, contributor.ID, contributor.Username, time.Minute)
			recorder = httptest.NewRecorder()
			server.router.ServeHTTP(recorder, request)
			require.Equal(t, http.StatusForbidden, recorder.Code, "%s answers a contributor", key)
		})
	}
	for key := range embedRoutes {
		require.True(t, registered[key], "embedRoutes lists %s, which is no longer a route", key)
	}
}

// routeExample fills a route template's parameters: /posts/:id/meta becomes
// /posts/1/meta.
func routeExample(path string) string {
	segments := strings.Split(path, "/")
	for i, segment := range segments {
		if strings.HasPrefix(segment, ":") || strings.HasPrefix(segment, "*") {
			segments[i] = "1"
		}
	}
	return strings.Join(segments, "/")
}

func TestRouteExample(t *testing.T) {
	require.Equal(t, "/api/v1/posts/1/meta", routeExample("/api/v1/posts/:id/meta"))
	require.Equal(t, "/api/v1/posts/1/versions/1", routeExample("/api/v1/posts/:id/versions/:version_no"))
	require.Equal(t, "/uploads/1", routeExample("/uploads/*filepath"))
	require.Equal(t, "/api/v1/posts", routeExample("/api/v1/posts"))
}
