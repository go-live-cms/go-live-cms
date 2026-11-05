package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Who may read which post (#393), through the real router and handlers against
// the test database (skipped without one, like auth_flow_test.go), so the list
// queries' viewer filter is the real SQL. Until #393 every /api/v1/posts read
// answered anyone with the working copy, drafts included, and the production
// proxy forwards /api/v1 to the API.
//
// The fixture: two contributors and an editor. owner has a draft (with meta)
// and a published post; other has a draft of their own. The draft's title,
// excerpt, slug and meta carry marker, which no response that mustn't show the
// draft may contain.

type postReadFixture struct {
	server *Server
	store  db.Store

	owner, other, editor db.User
	draft, published     db.Post
	otherDraft           db.Post
	marker               string
}

func newPostReadFixture(t *testing.T) postReadFixture {
	t.Helper()
	store := authFlowStore(t)
	server := authFlowServer(t, store, nil)

	suffix := lettersOnly(uuid.NewString())[:16]
	f := postReadFixture{server: server, store: store, marker: "leak" + suffix}
	f.owner = postReadUser(t, store, "owner"+suffix, RoleContributor)
	f.other = postReadUser(t, store, "other"+suffix, RoleContributor)
	f.editor = postReadUser(t, store, "editor"+suffix, RoleEditor)

	f.draft = postReadPost(t, store, f.owner, "draft", "Unreleased "+f.marker, f.marker)
	_, err := store.CreatePostMeta(context.Background(), db.CreatePostMetaParams{
		PostID: f.draft.ID, MetaKey: "_seo_note", MetaValue: sql.NullString{String: "meta " + f.marker, Valid: true},
	})
	require.NoError(t, err)
	f.published = postReadPost(t, store, f.owner, "published", "Live "+suffix, "live-"+suffix)
	f.otherDraft = postReadPost(t, store, f.other, "draft", "Other "+suffix, "other-"+suffix)
	return f
}

// lettersOnly maps a UUID's hex digits to letters, so the marker is one plain
// word to the full-text parser.
func lettersOnly(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= '0' && r <= '9':
			b.WriteRune('g' + (r - '0'))
		case r >= 'a' && r <= 'f':
			b.WriteRune(r)
		}
	}
	return b.String()
}

func postReadUser(t *testing.T, store db.Store, username string, role string) db.User {
	t.Helper()
	user, err := store.CreateUser(context.Background(), db.CreateUserParams{
		Username:       username,
		FullName:       "Reader " + role,
		Email:          username + "@example.test",
		HashedPassword: "not-a-login",
		Role:           role,
	})
	require.NoError(t, err)
	return user
}

func postReadPost(t *testing.T, store db.Store, owner db.User, status, title, slug string) db.Post {
	t.Helper()
	result, err := store.CreatePostTx(context.Background(), db.CreatePostTxParams{
		CreatePostsParams: db.CreatePostsParams{
			Title:       title,
			Slug:        slug,
			BlockDoc:    json.RawMessage(`{}`),
			Description: "Excerpt of " + title,
			UserID:      owner.ID,
			Username:    owner.Username,
			Url:         "https://example.test/" + slug,
			PostType:    "post",
			PostStatus:  status,
		},
		AuthorIDs: []int64{owner.ID},
	})
	require.NoError(t, err)
	return result.Post
}

// get GETs path as caller (nil: anonymous).
func (f postReadFixture) get(t *testing.T, caller *db.User, path string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, path, nil)
	if caller != nil {
		addAuthorization(t, request, f.server.tokenMaker, authorizationTypeBearer, caller.ID, caller.Username, time.Minute)
	}
	recorder := httptest.NewRecorder()
	f.server.router.ServeHTTP(recorder, request)
	return recorder
}

// postReadRouteTemplates are the GET routes that serve one post's working copy
// to content roles, each checking canReadPost. TestPerPostGETRoutesAreListed
// fails when a new per-post GET route isn't here (or in moderatorPostRoutes),
// so every one gets the per-role checks below.
var postReadRouteTemplates = []string{
	// Answered anyone before #393.
	"/api/v1/posts/:id",
	"/api/v1/posts/slug/:slug",
	"/api/v1/posts/:id/meta",
	"/api/v1/posts/:id/featured-image",
	"/api/v1/posts/:id/featured-image/full",
	"/api/v1/posts/:id/media",
	"/api/v1/posts/:id/taxonomies",
	"/api/v1/posts/:id/taxonomy-terms",
	"/api/v1/media/post/:id",
	// Signed in before #393, but any content role read any post's.
	"/api/v1/posts/:id/blocks",
	"/api/v1/posts/:id/settings",
	// The working byline (#319).
	"/api/v1/posts/:id/authors",
	// The owner (#353).
	"/api/v1/posts/:id/owner",
}

// moderatorPostRoutes are per-post GET routes for editors and admins only
// (requireContentEditor), so they need no per-post rule.
var moderatorPostRoutes = []string{
	"/api/v1/posts/:id/versions",
	"/api/v1/posts/:id/versions/:version_no",
}

// postReadRoutes are postReadRouteTemplates for post.
func (f postReadFixture) postReadRoutes(post db.Post) []string {
	paths := make([]string, len(postReadRouteTemplates))
	for i, template := range postReadRouteTemplates {
		path := strings.Replace(template, ":id", fmt.Sprint(post.ID), 1)
		paths[i] = strings.Replace(path, ":slug", post.Slug, 1)
	}
	return paths
}

func TestPerPostGETRoutesAreListed(t *testing.T) {
	server := newTestServer(t, nil)
	listed := map[string]bool{}
	for _, path := range append(append([]string{}, postReadRouteTemplates...), moderatorPostRoutes...) {
		listed[path] = true
	}

	registered := map[string]bool{}
	for _, route := range server.router.Routes() {
		if route.Method != http.MethodGet {
			continue
		}
		registered[route.Path] = true
		perPost := strings.HasPrefix(route.Path, "/api/v1/posts/:id") ||
			strings.HasPrefix(route.Path, "/api/v1/posts/slug/") ||
			strings.HasPrefix(route.Path, "/api/v1/media/post/")
		require.False(t, perPost && !listed[route.Path],
			"GET %s serves one post: check canReadPost in its handler and add it to postReadRouteTemplates (or moderatorPostRoutes)", route.Path)
	}
	for path := range listed {
		require.True(t, registered[path], "%s is listed but is no longer a GET route", path)
	}
}

func (f postReadFixture) listRoutes() []string {
	return []string{
		"/api/v1/posts",
		"/api/v1/posts?status=draft&with_meta=true",
		"/api/v1/posts?status=draft&with_meta=true&meta_level=full",
		"/api/v1/posts/counts",
		"/api/v1/posts/type/post?status=draft",
		fmt.Sprintf("/api/v1/posts/user/%d", f.owner.ID),
		"/api/v1/posts/search?q=" + f.marker,
	}
}

func TestPostReadRoutesNeedSignIn(t *testing.T) {
	f := newPostReadFixture(t)

	for _, path := range append(f.postReadRoutes(f.draft), f.listRoutes()...) {
		recorder := f.get(t, nil, path)
		require.Equal(t, http.StatusUnauthorized, recorder.Code, path)
		require.NotContains(t, recorder.Body.String(), f.marker, path)
	}
}

func TestPostReadRoutesPerPost(t *testing.T) {
	f := newPostReadFixture(t)

	testCases := []struct {
		name   string
		caller db.User
		post   db.Post
		want   int
	}{
		{name: "OwnerOwnDraft", caller: f.owner, post: f.draft, want: http.StatusOK},
		{name: "ContributorOthersDraft", caller: f.other, post: f.draft, want: http.StatusForbidden},
		{name: "ContributorOthersPublished", caller: f.other, post: f.published, want: http.StatusOK},
		{name: "EditorAnyDraft", caller: f.editor, post: f.draft, want: http.StatusOK},
		{name: "EditorAnyPublished", caller: f.editor, post: f.published, want: http.StatusOK},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			for _, path := range f.postReadRoutes(tc.post) {
				recorder := f.get(t, &tc.caller, path)
				require.Equal(t, tc.want, recorder.Code, "%s: %s", path, recorder.Body.String())
				if tc.want != http.StatusOK {
					require.NotContains(t, recorder.Body.String(), f.marker, path)
				}
			}
		})
	}

	// The working copy really is in the answers that are allowed.
	require.Contains(t, f.get(t, &f.owner, fmt.Sprintf("/api/v1/posts/%d", f.draft.ID)).Body.String(), f.marker)
	require.Contains(t, f.get(t, &f.editor, fmt.Sprintf("/api/v1/posts/%d/meta", f.draft.ID)).Body.String(), f.marker)
}

// listTotal GETs a list route and returns meta.total and the body.
func (f postReadFixture) listTotal(t *testing.T, caller db.User, path string) (int64, string) {
	t.Helper()
	recorder := f.get(t, &caller, path)
	require.Equal(t, http.StatusOK, recorder.Code, "%s: %s", path, recorder.Body.String())
	var body struct {
		Meta struct {
			Total int64 `json:"total"`
			Count int64 `json:"count"`
		} `json:"meta"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	if strings.Contains(path, "/posts/user/") {
		// This route has no total; count is the page.
		return body.Meta.Count, recorder.Body.String()
	}
	return body.Meta.Total, recorder.Body.String()
}

func (f postReadFixture) statusCounts(t *testing.T, caller db.User, query string) map[string]int64 {
	t.Helper()
	recorder := f.get(t, &caller, "/api/v1/posts/counts?"+query)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var body struct {
		Counts map[string]int64 `json:"counts"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	return body.Counts
}

func TestPostListsPerRole(t *testing.T) {
	f := newPostReadFixture(t)
	ownerFilter := fmt.Sprintf("user_id=%d", f.owner.ID)

	t.Run("ContributorSeesOthersPublishedOnly", func(t *testing.T) {
		for _, path := range []string{
			"/api/v1/posts?" + ownerFilter,
			"/api/v1/posts?with_meta=true&" + ownerFilter,
			"/api/v1/posts?with_meta=true&meta_level=full&" + ownerFilter,
			fmt.Sprintf("/api/v1/posts/user/%d", f.owner.ID),
		} {
			total, body := f.listTotal(t, f.other, path)
			require.Equal(t, int64(1), total, path)
			require.NotContains(t, body, f.marker, path)
			require.Contains(t, body, f.published.Title, path)
		}
		require.Equal(t, map[string]int64{"published": 1}, f.statusCounts(t, f.other, ownerFilter))

		// Every draft they can list is their own: they have exactly one.
		for _, path := range []string{
			"/api/v1/posts?status=draft",
			"/api/v1/posts/type/post?status=draft",
			"/api/v1/posts/type/post?status=draft&with_meta=true",
		} {
			total, body := f.listTotal(t, f.other, path)
			require.Equal(t, int64(1), total, path)
			require.Contains(t, body, f.otherDraft.Title, path)
			require.NotContains(t, body, f.marker, path)
		}

		total, body := f.listTotal(t, f.other, "/api/v1/posts/search?q="+f.marker)
		require.Zero(t, total)
		require.NotContains(t, body, "Unreleased")
	})

	t.Run("OwnerSeesOwnDrafts", func(t *testing.T) {
		total, body := f.listTotal(t, f.owner, "/api/v1/posts?status=draft&"+ownerFilter)
		require.Equal(t, int64(1), total)
		require.Contains(t, body, f.marker)
		require.Equal(t, map[string]int64{"draft": 1, "published": 1}, f.statusCounts(t, f.owner, ownerFilter))

		total, _ = f.listTotal(t, f.owner, "/api/v1/posts/search?q="+f.marker)
		require.Equal(t, int64(1), total)
	})

	t.Run("EditorSeesAll", func(t *testing.T) {
		total, body := f.listTotal(t, f.editor, "/api/v1/posts?"+ownerFilter)
		require.Equal(t, int64(2), total)
		require.Contains(t, body, f.marker)
		total, _ = f.listTotal(t, f.editor, fmt.Sprintf("/api/v1/posts/user/%d", f.owner.ID))
		require.Equal(t, int64(2), total)
		require.Equal(t, map[string]int64{"draft": 1, "published": 1}, f.statusCounts(t, f.editor, ownerFilter))

		total, _ = f.listTotal(t, f.editor, "/api/v1/posts/search?q="+f.marker)
		require.Equal(t, int64(1), total)
	})
}

// TestPublicNeverServesDrafts: /public is what anonymous visitors get, and the
// production proxy forwards it as is. Nothing there may show the draft: not by
// id, slug, list, search, author or as a neighbour of the published post.
func TestPublicNeverServesDrafts(t *testing.T) {
	f := newPostReadFixture(t)

	notFound := []string{
		fmt.Sprintf("/public/posts/%d", f.draft.ID),
		"/public/posts/slug/" + f.draft.Slug,
		fmt.Sprintf("/public/posts/%d/blocks", f.draft.ID),
		fmt.Sprintf("/public/posts/%d/adjacent", f.draft.ID),
		fmt.Sprintf("/public/posts/%d/related", f.draft.ID),
	}
	for _, path := range notFound {
		recorder := f.get(t, nil, path)
		require.Equal(t, http.StatusNotFound, recorder.Code, "%s: %s", path, recorder.Body.String())
		require.NotContains(t, recorder.Body.String(), f.marker, path)
	}

	// The lists sort newest first and the fixture's posts were just created, so
	// a list that leaked drafts would show this one on its first page.
	// The search answer echoes the query, so check its results.
	for _, query := range []string{f.marker, "Unreleased " + f.marker} {
		recorder := f.get(t, nil, "/public/search?q="+strings.ReplaceAll(query, " ", "+"))
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		var body struct {
			Results []json.RawMessage `json:"results"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
		require.Empty(t, body.Results, query)
	}

	for _, path := range []string{
		"/public/posts?type=post&limit=100",
		"/public/posts/type/post",
		"/public/authors/" + f.owner.Username + "/posts",
		fmt.Sprintf("/public/posts/%d/authors", f.draft.ID),
		fmt.Sprintf("/public/posts/%d/adjacent", f.published.ID),
		fmt.Sprintf("/public/posts/%d/related", f.published.ID),
		"/public/terms",
	} {
		recorder := f.get(t, nil, path)
		require.Less(t, recorder.Code, http.StatusInternalServerError, "%s: %s", path, recorder.Body.String())
		require.NotContains(t, recorder.Body.String(), f.marker, path)
	}

	// Signing in changes nothing on /public: it never serves the working copy.
	recorder := f.get(t, &f.owner, fmt.Sprintf("/public/posts/%d", f.draft.ID))
	require.Equal(t, http.StatusNotFound, recorder.Code)

	// The published post is there (so the checks above aren't vacuous).
	recorder = f.get(t, nil, fmt.Sprintf("/public/posts/%d", f.published.ID))
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	require.Contains(t, recorder.Body.String(), f.published.Title)
}
