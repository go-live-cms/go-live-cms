package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
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
