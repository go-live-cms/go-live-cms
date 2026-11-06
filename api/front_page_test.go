package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// The front page (#336): the setting (PUT /settings front_page_id) and the public
// route that renders it, GET /public/front-page. front_page_db_test.go runs the
// fallback against the real database.

// serveJSON sends body without a token.
func serveJSON(t *testing.T, server *Server, method, url, body string) *httptest.ResponseRecorder {
	t.Helper()
	request, err := http.NewRequest(method, url, strings.NewReader(body))
	require.NoError(t, err)
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	return recorder
}

func TestFrontPageUpdate(t *testing.T) {
	id := func(n int64) *int64 { return &n }
	for _, tc := range []struct {
		raw string
		set bool
		id  *int64
		err bool
	}{
		{"", false, nil, false},
		{"null", true, nil, false},
		{" null ", true, nil, false},
		{"12", true, id(12), false},
		{"0", false, nil, true},
		{"-3", false, nil, true},
		{`"12"`, false, nil, true},
		{"1.5", false, nil, true},
		{"{}", false, nil, true},
	} {
		set, got, err := UpdateSettingsRequest{FrontPageID: json.RawMessage(tc.raw)}.frontPageUpdate()
		require.Equal(t, tc.err, err != nil, tc.raw)
		require.Equal(t, tc.set, set, tc.raw)
		require.Equal(t, tc.id, got, tc.raw)
	}
}

func TestUpdateSettingsFrontPage(t *testing.T) {
	admin := db.User{ID: 31, Username: "front_admin", Role: RoleAdmin}
	editor := db.User{ID: 32, Username: "front_editor", Role: RoleEditor}
	publishedPage := db.Post{ID: 12, PostType: "page", PostStatus: "published"}
	pagesOn := db.PostType{Name: "page", Public: true, IsActive: true}
	updated := func(front sql.NullInt64) db.Setting {
		s := randomSetting()
		s.FrontPageID = front
		return s
	}

	for _, tc := range []struct {
		name  string
		user  db.User
		body  string
		stubs func(store *mockdb.MockStore)
		want  int
		check func(t *testing.T, body string)
	}{
		{"SetsPublishedPage", admin, `{"front_page_id": 12}`, func(store *mockdb.MockStore) {
			store.EXPECT().GetPost(gomock.Any(), int64(12)).Return(publishedPage, nil)
			store.EXPECT().GetPostType(gomock.Any(), "page").Return(pagesOn, nil)
			store.EXPECT().UpdateSettings(gomock.Any(), gomock.Any()).Times(1).
				DoAndReturn(func(_ any, arg db.UpdateSettingsParams) (db.Setting, error) {
					require.True(t, arg.SetFrontPage)
					require.Equal(t, sql.NullInt64{Int64: 12, Valid: true}, arg.FrontPageID)
					return updated(arg.FrontPageID), nil
				})
		}, http.StatusOK, func(t *testing.T, body string) { require.Contains(t, body, `"front_page_id":12`) }},
		{"NullShowsLatestPosts", admin, `{"front_page_id": null}`, func(store *mockdb.MockStore) {
			store.EXPECT().GetPost(gomock.Any(), gomock.Any()).Times(0)
			store.EXPECT().UpdateSettings(gomock.Any(), gomock.Any()).Times(1).
				DoAndReturn(func(_ any, arg db.UpdateSettingsParams) (db.Setting, error) {
					require.True(t, arg.SetFrontPage)
					require.False(t, arg.FrontPageID.Valid)
					return updated(arg.FrontPageID), nil
				})
		}, http.StatusOK, func(t *testing.T, body string) { require.Contains(t, body, `"front_page_id":null`) }},
		{"AbsentKeeps", admin, `{"site_title": "Renamed"}`, func(store *mockdb.MockStore) {
			store.EXPECT().UpdateSettings(gomock.Any(), gomock.Any()).Times(1).
				DoAndReturn(func(_ any, arg db.UpdateSettingsParams) (db.Setting, error) {
					require.False(t, arg.SetFrontPage)
					return updated(sql.NullInt64{Int64: 5, Valid: true}), nil
				})
		}, http.StatusOK, func(t *testing.T, body string) { require.Contains(t, body, `"front_page_id":5`) }},
		{"DraftPage", admin, `{"front_page_id": 12}`, func(store *mockdb.MockStore) {
			store.EXPECT().GetPost(gomock.Any(), int64(12)).Return(db.Post{ID: 12, PostType: "page", PostStatus: "draft"}, nil)
			store.EXPECT().UpdateSettings(gomock.Any(), gomock.Any()).Times(0)
		}, http.StatusBadRequest, func(t *testing.T, body string) { require.Contains(t, body, `"code":"invalid_front_page"`) }},
		{"TrashedPage", admin, `{"front_page_id": 12}`, func(store *mockdb.MockStore) {
			store.EXPECT().GetPost(gomock.Any(), int64(12)).Return(db.Post{ID: 12, PostType: "page", PostStatus: "trash"}, nil)
		}, http.StatusBadRequest, nil},
		{"NotAPage", admin, `{"front_page_id": 12}`, func(store *mockdb.MockStore) {
			store.EXPECT().GetPost(gomock.Any(), int64(12)).Return(db.Post{ID: 12, PostType: "post", PostStatus: "published"}, nil)
		}, http.StatusBadRequest, nil},
		{"MissingPage", admin, `{"front_page_id": 12}`, func(store *mockdb.MockStore) {
			store.EXPECT().GetPost(gomock.Any(), int64(12)).Return(db.Post{}, sql.ErrNoRows)
		}, http.StatusBadRequest, nil},
		{"LookupError", admin, `{"front_page_id": 12}`, func(store *mockdb.MockStore) {
			store.EXPECT().GetPost(gomock.Any(), int64(12)).Return(db.Post{}, fmt.Errorf("db down"))
		}, http.StatusInternalServerError, nil},
		// The site couldn't show it: /public/front-page wants an active, public type.
		{"PagesSwitchedOff", admin, `{"front_page_id": 12}`, func(store *mockdb.MockStore) {
			store.EXPECT().GetPost(gomock.Any(), int64(12)).Return(publishedPage, nil)
			store.EXPECT().GetPostType(gomock.Any(), "page").Return(db.PostType{Name: "page", Public: true, IsActive: false}, nil)
			store.EXPECT().UpdateSettings(gomock.Any(), gomock.Any()).Times(0)
		}, http.StatusBadRequest, func(t *testing.T, body string) { require.Contains(t, body, "switched off or not public") }},
		{"PagesNotPublic", admin, `{"front_page_id": 12}`, func(store *mockdb.MockStore) {
			store.EXPECT().GetPost(gomock.Any(), int64(12)).Return(publishedPage, nil)
			store.EXPECT().GetPostType(gomock.Any(), "page").Return(db.PostType{Name: "page", Public: false, IsActive: true}, nil)
		}, http.StatusBadRequest, nil},
		{"PageTypeMissing", admin, `{"front_page_id": 12}`, func(store *mockdb.MockStore) {
			store.EXPECT().GetPost(gomock.Any(), int64(12)).Return(publishedPage, nil)
			store.EXPECT().GetPostType(gomock.Any(), "page").Return(db.PostType{}, sql.ErrNoRows)
		}, http.StatusBadRequest, nil},
		{"PageTypeError", admin, `{"front_page_id": 12}`, func(store *mockdb.MockStore) {
			store.EXPECT().GetPost(gomock.Any(), int64(12)).Return(publishedPage, nil)
			store.EXPECT().GetPostType(gomock.Any(), "page").Return(db.PostType{}, fmt.Errorf("db down"))
		}, http.StatusInternalServerError, nil},
		{"NotAnID", admin, `{"front_page_id": "about"}`, func(store *mockdb.MockStore) {
			store.EXPECT().UpdateSettings(gomock.Any(), gomock.Any()).Times(0)
		}, http.StatusBadRequest, func(t *testing.T, body string) { require.Contains(t, body, `"code":"invalid_front_page"`) }},
		// Settings are admins' only, the front page with them.
		{"Editor", editor, `{"front_page_id": 12}`, func(store *mockdb.MockStore) {
			store.EXPECT().UpdateSettings(gomock.Any(), gomock.Any()).Times(0)
		}, http.StatusForbidden, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			tc.stubs(store)
			stubRoleLookup(store, tc.user)
			server := newTestServer(t, store)
			recorder := seoRequest(t, server, http.MethodPut, "/api/v1/settings", tc.body, tc.user)
			require.Equal(t, tc.want, recorder.Code, recorder.Body.String())
			if tc.check != nil {
				tc.check(t, recorder.Body.String())
			}
		})
	}

	t.Run("RecordsTheField", func(t *testing.T) {
		require.Equal(t, []string{"front_page_id"}, UpdateSettingsRequest{FrontPageID: json.RawMessage(`null`)}.setFields())
	})

	t.Run("SignedOut", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		recorder := serveJSON(t, newTestServer(t, store), http.MethodPut, "/api/v1/settings", `{"front_page_id": 12}`)
		require.Equal(t, http.StatusUnauthorized, recorder.Code)
	})
}

func TestGetSettingsFrontPage(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	setting := randomSetting()
	setting.FrontPageID = sql.NullInt64{Int64: 12, Valid: true}
	store.EXPECT().GetSettings(gomock.Any()).Return(setting, nil)
	recorder := serveSettingsGET(t, newTestServer(t, store), "/api/v1/settings")
	require.Equal(t, http.StatusOK, recorder.Code)
	require.Contains(t, recorder.Body.String(), `"front_page_id":12`)

	require.Nil(t, toSettingsResponse(randomSetting(), "").FrontPageID, "none set: the latest posts")
}

func TestGetPublicFrontPage(t *testing.T) {
	page := editedPublishedPost()
	page.PostType = "page"
	page.PageTemplate = "landing"
	page.PublishedSettings = publishedSettings(`{"title": "Home", "description": "Welcome", "featured_image": null,
		"term_ids": [], "page_template": "fullwidth"}`)

	t.Run("Page", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().GetPublicFrontPage(gomock.Any()).Times(1).Return(page, nil)
		store.EXPECT().GetPublishedPostTaxonomyTerms(gomock.Any(), page.ID).Return(nil, nil)
		recorder := serveSettingsGET(t, newTestServer(t, store), "/public/front-page")
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		var view publicPostView
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &view))
		// What the site shows: the published title and template, never the working ones.
		require.Equal(t, "Home", view.Post.Title)
		require.Equal(t, "fullwidth", view.Post.PageTemplate)
		require.Nil(t, view.Post.SEO)
		require.NotContains(t, recorder.Body.String(), "Working title")
	})

	t.Run("NoneMeansLatestPosts", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().GetPublicFrontPage(gomock.Any()).Return(db.Post{}, sql.ErrNoRows)
		recorder := serveSettingsGET(t, newTestServer(t, store), "/public/front-page")
		require.Equal(t, http.StatusNotFound, recorder.Code)
		require.Contains(t, recorder.Body.String(), `"code":"no_front_page"`)
	})

	t.Run("LookupError", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().GetPublicFrontPage(gomock.Any()).Return(db.Post{}, fmt.Errorf("db down"))
		require.Equal(t, http.StatusInternalServerError, serveSettingsGET(t, newTestServer(t, store), "/public/front-page").Code)
	})

	t.Run("ViewError", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().GetPublicFrontPage(gomock.Any()).Return(page, nil)
		store.EXPECT().GetPublishedPostTaxonomyTerms(gomock.Any(), page.ID).Return(nil, fmt.Errorf("db down"))
		require.Equal(t, http.StatusInternalServerError, serveSettingsGET(t, newTestServer(t, store), "/public/front-page").Code)
	})
}
