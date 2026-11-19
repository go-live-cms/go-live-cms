package api

import (
	"fmt"
	"io"
	"log/slog"
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

	"/api/v1/settings": "site title, tagline, language, time zone, URL structure: the public site's config (#330)",
	// Theme rows only: the queries behind these two can't return a plugin's row, which
	// may hold an API key (#451, TestPublicExtensionSettingsServeThemesOnly).
	"/api/v1/extension-settings":      "theme options the public theme reads (ThemeSettingsImpl); never a plugin's settings",
	"/api/v1/extension-settings/:key": "theme options the public theme reads (ThemeSettingsImpl); never a plugin's settings",

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

// publicPOSTRoutes are the writes anyone may send without a token (reader comments design
// 15.1, #524): every POST, PUT, PATCH or DELETE that doesn't answer 401 anonymously must
// be listed with its reason, so a new anonymous write gets a look (its limits, what it
// reveals, its cache). Until #524 they were /api/v1/auth only.
var publicPOSTRoutes = map[string]string{
	"POST /api/v1/auth/login":                "sign-in: per-IP and per IP+username limits, origin guard, same answer for a wrong name or password",
	"POST /api/v1/auth/refresh":              "the refresh cookie is the credential; origin guard, per-IP limit",
	"POST /api/v1/auth/password/forgot":      "same 200 for any address, work after the response, per-IP limit and a silent per-user cooldown",
	"POST /api/v1/auth/password/reset":       "the emailed token is the credential (account-token limit)",
	"POST /api/v1/auth/invitations/preview":  "the emailed token is the credential (account-token limit)",
	"POST /api/v1/auth/invitations/accept":   "the emailed token is the credential (account-token limit)",
	"POST /api/v1/auth/email-change/confirm": "the emailed token is the credential (account-token limit)",
	"POST /api/v1/auth/register":             "open signup (#191): off by default, same 202 for any address, limits and a silent cooldown",
	"POST /api/v1/auth/register/verify":      "the emailed token is the credential (account-token limit)",
	// Reader comments (#524, discussion_write.go). /public is server-side only: the web's
	// /gl-comments endpoints (origin check) are the callers.
	"POST /public/posts/:id/comments":         "a reader's comment: same 202 for any address without its browser key, limits per browser and per browser+address, a silent mail cooldown, caps, honeypot, rules",
	"POST /public/discussion/confirm":         "the emailed token is the credential, spent by the confirm page's button (account-token limit)",
	"POST /public/discussion/unconfirmed/:id": "the browser key of the comment's address is the credential (account-token limit)",
}

// stopOnStoreCall is a gomock reporter that turns any store call into a panic, which the
// recovery middleware answers 500: an anonymous request that got that far answered
// without a token.
type stopOnStoreCall struct{}

func (stopOnStoreCall) Errorf(format string, args ...any) { panic(fmt.Sprintf(format, args...)) }
func (stopOnStoreCall) Fatalf(format string, args ...any) { panic(fmt.Sprintf(format, args...)) }

func TestAnonymousWritesAreListed(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(stopOnStoreCall{}))
	server := newTestServer(t, store)
	server.logger = slog.New(slog.NewTextHandler(io.Discard, nil))

	registered := map[string]bool{}
	for _, route := range server.router.Routes() {
		switch route.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			continue
		}
		key := route.Method + " " + route.Path
		registered[key] = true
		t.Run(key, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(route.Method, routeExample(route.Path), strings.NewReader(`{}`))
			request.Header.Set("Content-Type", "application/json")
			server.router.ServeHTTP(recorder, request)
			_, listed := publicPOSTRoutes[key]
			if strings.HasPrefix(route.Path, "/public/") {
				require.True(t, listed, "%s is an anonymous write under /public: list it in publicPOSTRoutes with its reason", key)
			}
			if listed {
				require.NotEqual(t, http.StatusUnauthorized, recorder.Code, "%s is listed in publicPOSTRoutes but needs a token", key)
				return
			}
			require.Equal(t, http.StatusUnauthorized, recorder.Code,
				"%s answers without a token: add authMiddleware, or list it in publicPOSTRoutes with the reason it may be anonymous", key)
		})
	}
	for key := range publicPOSTRoutes {
		require.True(t, registered[key], "publicPOSTRoutes lists %s, which is no longer a route", key)
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
		if strings.HasPrefix(route.Path, "/public/") {
			// Reader comments (#499), never #192's: the public discussion. Their writes
			// are audited by TestAnonymousWritesAreListed, and no /public route reads
			// post_comments.
			_, reader := publicPOSTRoutes[key]
			require.True(t, reader || route.Method == http.MethodGet, "%s: a /public comment route must be a reader comment route", key)
			continue
		}
		registered[key] = true
		_, listed := commentRoutes[key]
		require.True(t, listed, "%s is a comment route missing from commentRoutes", key)

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

// commandPaletteRoutes is the admin command palette's route (#41). TestGETRoutesRequireAuth
// already walks it; this also says what it answers and to whom, and fails when the route
// is removed or another method is added on it without being listed.
var commandPaletteRoutes = map[string]string{
	"GET /api/v1/search": "content roles; posts through postsViewerID, users for admins only",
}

func TestCommandPaletteRoutesRequireAuth(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)

	registered := map[string]bool{}
	for _, route := range server.router.Routes() {
		if route.Path != "/api/v1/search" {
			continue
		}
		key := route.Method + " " + route.Path
		registered[key] = true
		_, listed := commandPaletteRoutes[key]
		require.True(t, listed, "%s is a command palette route missing from commandPaletteRoutes", key)

		t.Run(key, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, httptest.NewRequest(route.Method, routeExample(route.Path)+"?q=draft", nil))
			require.Equal(t, http.StatusUnauthorized, recorder.Code, "%s answers without a token", key)
		})
	}
	for key := range commandPaletteRoutes {
		require.True(t, registered[key], "commandPaletteRoutes lists %s, which is no longer a route", key)
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

// htmlSnippetRoutes are the custom HTML routes (#428), every method. They are how markup
// gets into the post, so TestHTMLSnippetRoutesRequireRole fails when one is added without
// being listed here (so its rule gets a look), or answers an anonymous request, or a write
// answers an editor or a contributor.
var htmlSnippetRoutes = map[string]string{
	"GET /api/v1/posts/:id/html-snippets":             "canReadPost: the locked preview",
	"POST /api/v1/posts/:id/html-snippets":            "requireSiteAdmin",
	"PUT /api/v1/posts/:id/html-snippets/:snippet_id": "requireSiteAdmin",
}

func TestHTMLSnippetRoutesRequireRole(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)
	editor := db.User{ID: 51, Username: "editor", Role: RoleEditor}
	contributor := db.User{ID: 52, Username: "contrib", Role: RoleContributor}
	store.EXPECT().GetUser(gomock.Any(), editor.ID).AnyTimes().Return(editor, nil)
	store.EXPECT().GetUser(gomock.Any(), contributor.ID).AnyTimes().Return(contributor, nil)

	registered := map[string]bool{}
	for _, route := range server.router.Routes() {
		if !strings.Contains(route.Path, "html-snippets") {
			continue
		}
		key := route.Method + " " + route.Path
		registered[key] = true
		_, listed := htmlSnippetRoutes[key]
		require.True(t, listed, "%s is a custom HTML route missing from htmlSnippetRoutes", key)
		require.False(t, strings.HasPrefix(route.Path, "/public"), "the working markup is never public: %s", key)

		t.Run(key, func(t *testing.T) {
			body := `{"html":"<b>x</b>"}`
			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, httptest.NewRequest(route.Method, routeExample(route.Path), strings.NewReader(body)))
			require.Equal(t, http.StatusUnauthorized, recorder.Code, "%s answers without a token", key)

			if route.Method == http.MethodGet {
				return
			}
			for _, caller := range []db.User{editor, contributor} {
				request := httptest.NewRequest(route.Method, routeExample(route.Path), strings.NewReader(body))
				addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, caller.ID, caller.Username, time.Minute)
				recorder = httptest.NewRecorder()
				server.router.ServeHTTP(recorder, request)
				require.Equal(t, http.StatusForbidden, recorder.Code, "%s answers a %s", key, caller.Role)
			}
		})
	}
	for key := range htmlSnippetRoutes {
		require.True(t, registered[key], "htmlSnippetRoutes lists %s, which is no longer a route", key)
	}
}

// siteDesignRoutes are the site design routes (#485, design section 12): every method is
// requireSiteAdmin, and none is under /public. The draft's only readers are these and
// GET /site-design/draft, the named exception (#486): its bearer is a design preview
// token, never an access token, and it re-checks that the token's user is still an admin
// (TestDesignDraftRead). The published styles' only public read is GET /themes/active
// (TestDraftGlobalStylesNeverPublic proves the draft isn't there or on any /public route).
var siteDesignRoutes = map[string]string{
	"GET /api/v1/site-design/global-styles":                       "requireSiteAdmin: the draft",
	"PUT /api/v1/site-design/global-styles":                       "requireSiteAdmin",
	"POST /api/v1/site-design/publish":                            "requireSiteAdmin",
	"POST /api/v1/site-design/preview":                            "requireSiteAdmin: mints a preview token",
	"GET /api/v1/site-design/draft":                               "previewTokenOnly: the draft, for a preview token whose user is still an admin",
	"POST /api/v1/site-design/templates":                          "requireSiteAdmin: templates and parts are admins' only (#490)",
	"GET /api/v1/site-design/templates":                           "requireSiteAdmin: working copies and what a publish would do (#492)",
	"GET /api/v1/site-design/templates/:id":                       "requireSiteAdmin: a working copy (#492)",
	"DELETE /api/v1/site-design/templates/:id":                    "requireSiteAdmin (#492)",
	"POST /api/v1/site-design/templates/:id/reset":                "requireSiteAdmin (#492)",
	"POST /api/v1/site-design/templates/:id/keep-editing":         "requireSiteAdmin (#492)",
	"GET /api/v1/site-design/templates/:id/default":               "requireSiteAdmin: the theme default for Start over (#492)",
	"POST /api/v1/site-design/templates/:id/start-over":           "requireSiteAdmin (#492)",
	"GET /api/v1/site-design/templates/:id/versions":              "requireSiteAdmin: history (#492)",
	"GET /api/v1/site-design/templates/:id/versions/:no":          "requireSiteAdmin: a version, for the editor's restore (#492)",
	"POST /api/v1/site-design/templates/:id/versions/:no/restore": "requireSiteAdmin (#492)",
	"GET /api/v1/site-design/releases":                            "requireSiteAdmin: history (#492)",
	"GET /api/v1/site-design/global-styles/versions":              "requireSiteAdmin: history (#492)",
	"GET /api/v1/site-design/global-styles/versions/:no":          "requireSiteAdmin: a version (#492)",
	"POST /api/v1/site-design/global-styles/versions/:no/restore": "requireSiteAdmin (#492)",
	"POST /api/v1/site-design/global-styles/discard":              "requireSiteAdmin (#492)",
}

func TestSiteDesignRoutesRequireAdmin(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)
	editor := db.User{ID: 53, Username: "editor", Role: RoleEditor}
	contributor := db.User{ID: 54, Username: "contributor", Role: RoleContributor}
	store.EXPECT().GetUser(gomock.Any(), editor.ID).AnyTimes().Return(editor, nil)
	store.EXPECT().GetUser(gomock.Any(), contributor.ID).AnyTimes().Return(contributor, nil)

	registered := map[string]bool{}
	for _, route := range server.router.Routes() {
		if !strings.Contains(route.Path, "site-design") {
			continue
		}
		key := route.Method + " " + route.Path
		registered[key] = true
		_, listed := siteDesignRoutes[key]
		require.True(t, listed, "%s is a site design route missing from siteDesignRoutes", key)
		require.False(t, strings.HasPrefix(route.Path, "/public"), "the site design draft is never public: %s", key)

		t.Run(key, func(t *testing.T) {
			body := `{"styles":{},"base_revision":0}`
			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, httptest.NewRequest(route.Method, routeExample(route.Path), strings.NewReader(body)))
			require.Equal(t, http.StatusUnauthorized, recorder.Code, "%s answers without a token", key)
			for _, caller := range []db.User{editor, contributor} {
				request := httptest.NewRequest(route.Method, routeExample(route.Path), strings.NewReader(body))
				addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, caller.ID, caller.Username, time.Minute)
				recorder = httptest.NewRecorder()
				server.router.ServeHTTP(recorder, request)
				if strings.HasPrefix(siteDesignRoutes[key], "previewTokenOnly") {
					// An access token, whoever's, is never a preview token.
					require.Equal(t, http.StatusUnauthorized, recorder.Code, "%s answers a %s's access token", key, caller.Role)
					continue
				}
				require.Equal(t, http.StatusForbidden, recorder.Code, "%s answers a %s", key, caller.Role)
			}
		})
	}
	for key := range siteDesignRoutes {
		require.True(t, registered[key], "siteDesignRoutes lists %s, which is no longer a route", key)
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
