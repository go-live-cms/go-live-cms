package api

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"fmt"
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
		if _, reader := publicReaderCommentRoutes[key]; reader && strings.HasPrefix(route.Path, "/public/") {
			// Reader comments (#499) are another feature: TestPublicReaderCommentRoutes.
			// Only on /public: anything else named "comment" still answers 401 here.
			continue
		}
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

// publicReaderCommentRoutes are the /public reader comment routes (#499), every method,
// with what they may answer. TestPublicReaderCommentRoutes fails when one is added
// without being listed; TestPublicCommentAnswersHoldNoAddress renders every GET here.
// The writes (#524) add themselves with their reason (and to publicCacheDiscussionRoutes).
var publicReaderCommentRoutes = map[string]string{
	"GET /public/posts/:id/comments": "approved comments of a published post of a public type; no address, commenter id, status or hash (7.1)",
}

func TestPublicReaderCommentRoutes(t *testing.T) {
	server := newTestServer(t, mockdb.NewMockStore(gomock.NewController(t)))
	registered := map[string]bool{}
	for _, route := range server.router.Routes() {
		if !strings.HasPrefix(route.Path, "/public") || !strings.Contains(route.Path, "comment") {
			continue
		}
		key := route.Method + " " + route.Path
		registered[key] = true
		_, listed := publicReaderCommentRoutes[key]
		require.True(t, listed, "%s is a public comment route missing from publicReaderCommentRoutes", key)
		if route.Method == http.MethodGet {
			_, cached := publicCacheRoutes[route.Path]
			require.True(t, cached, "%s: public comment reads are cached like every /public read (#185)", key)
		}
	}
	for key := range publicReaderCommentRoutes {
		require.True(t, registered[key], "publicReaderCommentRoutes lists %s, which is no longer a route", key)
		_, path, _ := strings.Cut(key, " ")
		require.True(t, strings.HasPrefix(path, "/public/"), "publicReaderCommentRoutes is for /public routes only: %s", key)
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

// TestPublicCommentAnswersHoldNoAddress is design 7.1's address check, against the test
// database: every /public reader comment read (and the post reads that carry
// `discussion`), rendered for a post with comments from a commenter and a member whose
// addresses are known, holds neither address in any case, nor a hash or token stored with
// the comments, nor the text of a comment that isn't approved.
func TestPublicCommentAnswersHoldNoAddress(t *testing.T) {
	f := newCommentsFixture(t)
	ctx := context.Background()
	post := f.publishedPost(t)
	reader := f.commenter(t)
	root := f.says(t, post, reader, nil, db.ReaderCommentApproved, marker("approved"))
	reply := f.says(t, post, reader, &root, db.ReaderCommentApproved, marker("approved reply"))
	f.byMember(t, post, f.editor, marker("by a member"))
	unapproved := []db.ReaderComment{
		f.says(t, post, reader, &root, db.ReaderCommentPending, marker("pending")),
		f.says(t, post, reader, &root, db.ReaderCommentSpam, marker("spam")),
		f.says(t, post, reader, nil, db.ReaderCommentUnconfirmed, marker("unconfirmed")),
	}
	trashed := f.says(t, post, reader, &reply, db.ReaderCommentApproved, marker("trashed"))
	_, err := f.store.TrashReaderComment(ctx, db.TrashReaderCommentParams{ID: trashed.ID})
	require.NoError(t, err)
	unapproved = append(unapproved, trashed)

	forbidden := []string{reader.Email, reader.EmailLower, strings.ToUpper(reader.Email), f.editor.Email, strings.ToLower(f.editor.Email)}
	var secrets [][]byte
	rows, err := f.conn.Query(`SELECT network_hash, confirm_token_hash FROM reader_comments WHERE post_id = $1`, post.ID)
	require.NoError(t, err)
	for rows.Next() {
		var network, confirm []byte
		require.NoError(t, rows.Scan(&network, &confirm))
		secrets = append(secrets, network, confirm)
	}
	require.NoError(t, rows.Close())
	for _, secret := range secrets {
		if len(secret) == 0 {
			continue
		}
		forbidden = append(forbidden, string(secret), hex.EncodeToString(secret), base64.StdEncoding.EncodeToString(secret),
			base64.RawURLEncoding.EncodeToString(secret))
	}

	var paths []string
	for key := range publicReaderCommentRoutes {
		method, template, _ := strings.Cut(key, " ")
		if method != http.MethodGet {
			continue
		}
		path := strings.ReplaceAll(template, ":id", fmt.Sprint(post.ID))
		require.NotContains(t, path, ":", "%s: fill its parameters here", key)
		paths = append(paths, path, path+fmt.Sprintf("?thread=%d", root.ID))
	}
	paths = append(paths, fmt.Sprintf("/public/posts/%d", post.ID), "/public/posts/slug/"+post.Slug)

	for _, path := range paths {
		recorder := f.read(t, path)
		require.Equal(t, http.StatusOK, recorder.Code, "%s: %s", path, recorder.Body.String())
		body := recorder.Body.String()
		require.Contains(t, body, `"discussion"`, path)
		for _, value := range forbidden {
			require.NotContains(t, strings.ToLower(body), strings.ToLower(value), "%s holds an address, hash or token", path)
		}
		for _, comment := range unapproved {
			require.NotContains(t, body, comment.Body, "%s serves a %s comment", path, comment.Status)
		}
		if strings.Contains(path, "/comments") {
			require.Contains(t, body, root.Body, "%s: the check isn't vacuous", path)
		}
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
