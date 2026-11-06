package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// #331: redirects (redirects.go), category rules, merges and post URLs, on the mock
// store. taxonomies_redirects_db_test.go runs the flows against the real database.

func asMock(t *testing.T, server *Server, caller db.User, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	return doJSON(t, server, method, path, body, func(r *http.Request) {
		addAuthorization(t, r, server.tokenMaker, authorizationTypeBearer, caller.ID, caller.Username, time.Minute)
	})
}

func mockCaller(t *testing.T, role string) (*mockdb.MockStore, *Server, db.User) {
	t.Helper()
	store := mockdb.NewMockStore(gomock.NewController(t))
	caller := randomUserNew()
	caller.Role = role
	stubRoleLookup(store, caller)
	return store, newTestServer(t, store), caller
}

func responseCode(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Code string `json:"code"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	return body.Code
}

func TestNormalizeSitePath(t *testing.T) {
	for in, want := range map[string]string{
		"/old":           "/old",
		" /old/ ":        "/old",
		"/old///":        "/old",
		"/":              "/",
		"/caf%C3%A9":     "/café",
		"/tag/são-paulo": "/tag/são-paulo",
	} {
		got, problem := normalizeSitePath(in)
		require.Empty(t, problem, in)
		require.Equal(t, want, got, in)
	}
	for _, bad := range []string{"", "old", "//evil.example", "/a?b=1", "/a#x", "/a b", "/a\\b", "/%zz", "/%2F%2Fx", "https://example.com/x"} {
		_, problem := normalizeSitePath(bad)
		require.NotEmpty(t, problem, bad)
	}
	require.True(t, isReservedSitePath("/gl-admin/settings"))
	require.True(t, isReservedSitePath("/API/v1"))
	require.False(t, isReservedSitePath("/apis"))

	for in, want := range map[string]string{
		"/new/":                  "/new",
		"https://golive.dev/x?y": "https://golive.dev/x?y",
	} {
		got, problem := normalizeRedirectTarget(in)
		require.Empty(t, problem, in)
		require.Equal(t, want, got)
	}
	for _, bad := range []string{"javascript:alert(1)", "ftp://x.example", "https://", "https://user:pw@x.example/", "//x.example", "new"} {
		_, problem := normalizeRedirectTarget(bad)
		require.NotEmpty(t, problem, bad)
	}
}

func TestPostURLPaths(t *testing.T) {
	require.Equal(t, "/guides/hello", postHref("post", "hello", 7, "category", "guides"))
	require.Equal(t, "/post/hello", postHref("post", "hello", 7, "category", ""), "no category: the slug form")
	require.Equal(t, "/page/about", postHref("page", "about", 7, "category", "guides"), "only posts take the category")
	require.Equal(t, "/post/7", postHref("post", "2026", 7, "category", "guides"), "an all-digit slug reads as an id")
	require.Equal(t, "/post/7", postHref("post", "hello", 7, "id", "guides"))
	require.Equal(t, "/s%C3%A3o/ol%C3%A1", postHref("post", "olá", 7, "category", "são"))
	require.Equal(t, "/são/olá", postSitePath("post", "olá", 7, "category", "são"))
	require.Equal(t, "/guides/hello", menuPostPath("post", "hello", 7, "category", "guides"))
	require.Equal(t, "/tag/go", termSitePath("tag", "go"))
}

func TestCreateRedirectAPI(t *testing.T) {
	t.Run("AdminAddsManualRedirect", func(t *testing.T) {
		store, server, admin := mockCaller(t, RoleAdmin)
		created := db.Redirect{ID: 9, FromPath: "/old", ToPath: "/new", StatusCode: 302, Source: db.RedirectSourceManual,
			CreatedBy: sql.NullInt64{Int64: admin.ID, Valid: true}, CreatedAt: time.Now()}
		store.EXPECT().AddRedirectTx(gomock.Any(), db.AddRedirectParams{
			FromPath: "/old", ToPath: "/new", StatusCode: 302, Source: db.RedirectSourceManual, CreatedBy: admin.ID,
		}).Return(created, nil)

		recorder := asMock(t, server, admin, http.MethodPost, "/api/v1/redirects", gin.H{"from_path": "/old/", "to_path": "/new", "status_code": 302})
		requireStatus(t, recorder, http.StatusCreated)
		var body struct {
			Redirect RedirectResponse `json:"redirect"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
		require.Equal(t, "/new", body.Redirect.ToPath)
		require.False(t, body.Redirect.External)
		require.NotNil(t, body.Redirect.CreatedBy)
		require.Equal(t, admin.Username, body.Redirect.CreatedBy.Username)
		require.Equal(t, []string{fmt.Sprintf("%s redirect:%d", db.ActivityRedirectCreated, 9)}, activityOf(t, server).verbs())
	})

	t.Run("DefaultsTo301", func(t *testing.T) {
		store, server, admin := mockCaller(t, RoleAdmin)
		store.EXPECT().AddRedirectTx(gomock.Any(), gomock.Any()).DoAndReturn(func(_ any, arg db.AddRedirectParams) (db.Redirect, error) {
			require.EqualValues(t, 301, arg.StatusCode)
			return db.Redirect{ID: 1, FromPath: arg.FromPath, ToPath: arg.ToPath, StatusCode: arg.StatusCode, Source: arg.Source}, nil
		})
		requireStatus(t, asMock(t, server, admin, http.MethodPost, "/api/v1/redirects", gin.H{"from_path": "/launch", "to_path": "https://golive.dev/launch"}), http.StatusCreated)
	})

	for _, tc := range []struct {
		name string
		body gin.H
		code string
	}{
		{"NotAPath", gin.H{"from_path": "old", "to_path": "/new"}, ""},
		{"AdminPath", gin.H{"from_path": "/gl-admin/x", "to_path": "/new"}, ""},
		{"HomePage", gin.H{"from_path": "/", "to_path": "/new"}, ""},
		{"BadTarget", gin.H{"from_path": "/old", "to_path": "javascript:alert(1)"}, ""},
		{"Status", gin.H{"from_path": "/old", "to_path": "/new", "status_code": 307}, ""},
		{"Self", gin.H{"from_path": "/old/", "to_path": "/old"}, "redirect_loop"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store, server, admin := mockCaller(t, RoleAdmin)
			store.EXPECT().AddRedirectTx(gomock.Any(), gomock.Any()).Times(0)
			recorder := asMock(t, server, admin, http.MethodPost, "/api/v1/redirects", tc.body)
			requireStatus(t, recorder, http.StatusBadRequest)
			if tc.code != "" {
				require.Equal(t, tc.code, responseCode(t, recorder))
			}
		})
	}

	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{db.ErrRedirectLoop, http.StatusBadRequest, "redirect_loop"},
		{db.ErrRedirectExists, http.StatusConflict, "redirect_exists"},
		{errors.New("boom"), http.StatusInternalServerError, ""},
	} {
		t.Run("Store "+tc.err.Error(), func(t *testing.T) {
			store, server, admin := mockCaller(t, RoleAdmin)
			store.EXPECT().AddRedirectTx(gomock.Any(), gomock.Any()).Return(db.Redirect{}, tc.err)
			recorder := asMock(t, server, admin, http.MethodPost, "/api/v1/redirects", gin.H{"from_path": "/a", "to_path": "/b"})
			requireStatus(t, recorder, tc.status)
			if tc.code != "" {
				require.Equal(t, tc.code, responseCode(t, recorder))
			}
		})
	}

	t.Run("EditorForbidden", func(t *testing.T) {
		store, server, editor := mockCaller(t, RoleEditor)
		store.EXPECT().AddRedirectTx(gomock.Any(), gomock.Any()).Times(0)
		store.EXPECT().ListRedirects(gomock.Any(), gomock.Any()).Times(0)
		requireStatus(t, asMock(t, server, editor, http.MethodPost, "/api/v1/redirects", gin.H{"from_path": "/a", "to_path": "/b"}), http.StatusForbidden)
		requireStatus(t, asMock(t, server, editor, http.MethodGet, "/api/v1/redirects", nil), http.StatusForbidden)
		requireStatus(t, asMock(t, server, editor, http.MethodDelete, "/api/v1/redirects/3", nil), http.StatusForbidden)
	})
}

func TestListAndDeleteRedirectsAPI(t *testing.T) {
	t.Run("List", func(t *testing.T) {
		store, server, admin := mockCaller(t, RoleAdmin)
		store.EXPECT().ListRedirects(gomock.Any(), db.ListRedirectsParams{Query: "%photo\\_s%", RowLimit: 20, RowOffset: 40}).Return([]db.ListRedirectsRow{
			{ID: 2, FromPath: "/tag/photos", ToPath: "/tag/images", StatusCode: 301, Source: db.RedirectSourceMerge,
				CreatedBy: sql.NullInt64{Int64: 5, Valid: true}, CreatedByUsername: sql.NullString{String: "ana", Valid: true},
				CreatedByFullName: sql.NullString{String: "Ana Costa", Valid: true}},
			{ID: 1, FromPath: "/launch", ToPath: "https://golive.dev/launch", StatusCode: 302, Source: db.RedirectSourceManual},
		}, nil)
		store.EXPECT().CountRedirects(gomock.Any(), "%photo\\_s%").Return(int64(42), nil)

		recorder := asMock(t, server, admin, http.MethodGet, "/api/v1/redirects?q=photo_s&limit=20&offset=40", nil)
		requireStatus(t, recorder, http.StatusOK)
		var body struct {
			Redirects []RedirectResponse `json:"redirects"`
			Total     int64              `json:"total"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
		require.EqualValues(t, 42, body.Total)
		require.Len(t, body.Redirects, 2)
		require.Equal(t, "Ana Costa", body.Redirects[0].CreatedBy.FullName)
		require.Nil(t, body.Redirects[0].CreatedBy.Avatar)
		require.True(t, body.Redirects[1].External)
		require.Nil(t, body.Redirects[1].CreatedBy)
	})

	t.Run("BadPaging", func(t *testing.T) {
		_, server, admin := mockCaller(t, RoleAdmin)
		requireStatus(t, asMock(t, server, admin, http.MethodGet, "/api/v1/redirects?limit=500", nil), http.StatusBadRequest)
		requireStatus(t, asMock(t, server, admin, http.MethodGet, "/api/v1/redirects?offset=-1", nil), http.StatusBadRequest)
	})

	t.Run("Delete", func(t *testing.T) {
		store, server, admin := mockCaller(t, RoleAdmin)
		store.EXPECT().DeleteRedirect(gomock.Any(), int64(3)).Return(db.Redirect{ID: 3, StatusCode: 301, Source: "manual"}, nil)
		store.EXPECT().DeleteRedirect(gomock.Any(), int64(4)).Return(db.Redirect{}, sql.ErrNoRows)
		requireStatus(t, asMock(t, server, admin, http.MethodDelete, "/api/v1/redirects/3", nil), http.StatusNoContent)
		requireStatus(t, asMock(t, server, admin, http.MethodDelete, "/api/v1/redirects/4", nil), http.StatusNotFound)
		requireStatus(t, asMock(t, server, admin, http.MethodDelete, "/api/v1/redirects/x", nil), http.StatusBadRequest)
		require.Equal(t, []string{db.ActivityRedirectDeleted + " redirect:3"}, activityOf(t, server).verbs())
	})
}

func TestPublicRedirectLookup(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)
	store.EXPECT().GetRedirectByFromPath(gomock.Any(), "/tag/são").Return(db.Redirect{ToPath: "/tag/images", StatusCode: 301}, nil)
	store.EXPECT().GetRedirectByFromPath(gomock.Any(), "/nothing").Return(db.Redirect{}, sql.ErrNoRows)

	recorder := doJSON(t, server, http.MethodGet, "/public/redirects?path=/tag/s%25C3%25A3o/", nil, nil)
	requireStatus(t, recorder, http.StatusOK)
	require.JSONEq(t, `{"to_path":"/tag/images","status_code":301}`, recorder.Body.String())
	requireStatus(t, doJSON(t, server, http.MethodGet, "/public/redirects?path=/nothing", nil, nil), http.StatusNotFound)
	// Never looked up: not a site path, or the admin's.
	requireStatus(t, doJSON(t, server, http.MethodGet, "/public/redirects?path=nothing", nil, nil), http.StatusNotFound)
	requireStatus(t, doJSON(t, server, http.MethodGet, "/public/redirects?path=/gl-admin", nil, nil), http.StatusNotFound)
}

func TestCategoryTermRules(t *testing.T) {
	category := db.TaxonomyType{ID: 1, Name: "category", Hierarchical: true, Public: true, DefaultTermID: sql.NullInt64{Int64: 99, Valid: true}}
	top := db.TaxonomyTerm{ID: 10, Name: "Guides", Slug: "guides", TaxonomyTypeID: 1}
	child := db.TaxonomyTerm{ID: 11, Name: "How-to", Slug: "how-to", TaxonomyTypeID: 1, ParentID: sql.NullInt64{Int64: 10, Valid: true}}
	other := db.TaxonomyTerm{ID: 12, Name: "News", Slug: "news", TaxonomyTypeID: 1}
	terms := map[int64]db.TaxonomyTerm{10: top, 11: child, 12: other}
	stub := func(store *mockdb.MockStore) {
		store.EXPECT().GetTaxonomyTypeByID(gomock.Any(), int64(1)).Return(category, nil).AnyTimes()
		store.EXPECT().GetTaxonomyTerm(gomock.Any(), gomock.Any()).AnyTimes().DoAndReturn(func(_ any, id int64) (db.TaxonomyTerm, error) {
			if term, ok := terms[id]; ok {
				return term, nil
			}
			return db.TaxonomyTerm{}, sql.ErrNoRows
		})
	}

	t.Run("CreateUnderChildIsTooDeep", func(t *testing.T) {
		store, server, editor := mockCaller(t, RoleEditor)
		stub(store)
		store.EXPECT().CreateTaxonomyTerm(gomock.Any(), gomock.Any()).Times(0)
		recorder := asMock(t, server, editor, http.MethodPost, "/api/v1/taxonomy/terms", gin.H{"name": "Deep", "taxonomy_type_id": 1, "parent_id": 11})
		requireStatus(t, recorder, http.StatusBadRequest)
		require.Equal(t, "nesting_too_deep", responseCode(t, recorder))
	})

	t.Run("ParentWithChildrenStaysTopLevel", func(t *testing.T) {
		store, server, editor := mockCaller(t, RoleEditor)
		stub(store)
		store.EXPECT().CountTermChildren(gomock.Any(), sql.NullInt64{Int64: 10, Valid: true}).Return(int64(1), nil)
		store.EXPECT().UpdateTaxonomyTerm(gomock.Any(), gomock.Any()).Times(0)
		recorder := asMock(t, server, editor, http.MethodPut, "/api/v1/taxonomy/terms/10", gin.H{"parent_id": 12})
		requireStatus(t, recorder, http.StatusBadRequest)
		require.Equal(t, "nesting_too_deep", responseCode(t, recorder))
	})

	t.Run("ReservedSlug", func(t *testing.T) {
		store, server, editor := mockCaller(t, RoleEditor)
		stub(store)
		store.EXPECT().IsPostTypeOrTaxonomyName(gomock.Any(), "tag").Return(true, nil)
		store.EXPECT().CreateTaxonomyTerm(gomock.Any(), gomock.Any()).Times(0)
		recorder := asMock(t, server, editor, http.MethodPost, "/api/v1/taxonomy/terms", gin.H{"name": "Tag", "taxonomy_type_id": 1})
		requireStatus(t, recorder, http.StatusBadRequest)
		require.Equal(t, "slug_reserved", responseCode(t, recorder))
		recorder = asMock(t, server, editor, http.MethodPost, "/api/v1/taxonomy/terms", gin.H{"name": "Search", "taxonomy_type_id": 1})
		require.Equal(t, "slug_reserved", responseCode(t, recorder))
	})

	t.Run("SlugChangeRedirectsTheArchive", func(t *testing.T) {
		store, server, editor := mockCaller(t, RoleEditor)
		stub(store)
		store.EXPECT().IsPostTypeOrTaxonomyName(gomock.Any(), "tutorials").Return(false, nil)
		store.EXPECT().UpdateTaxonomyTermTx(gomock.Any(), gomock.Any()).DoAndReturn(func(_ any, arg db.UpdateTaxonomyTermTxParams) (db.TaxonomyTerm, error) {
			require.Equal(t, "tutorials", arg.Slug)
			require.Equal(t, &db.AddRedirectParams{FromPath: "/category/guides", ToPath: "/category/tutorials", StatusCode: 301,
				Source: db.RedirectSourceTerm, CreatedBy: editor.ID}, arg.Redirect)
			return db.TaxonomyTerm{ID: 10, Name: "Guides", Slug: "tutorials", TaxonomyTypeID: 1}, nil
		})
		requireStatus(t, asMock(t, server, editor, http.MethodPut, "/api/v1/taxonomy/terms/10", gin.H{"slug": "tutorials"}), http.StatusOK)
	})

	t.Run("DeleteDefault", func(t *testing.T) {
		store, server, editor := mockCaller(t, RoleEditor)
		store.EXPECT().GetTaxonomyTerm(gomock.Any(), int64(99)).Return(db.TaxonomyTerm{ID: 99, TaxonomyTypeID: 1}, nil)
		store.EXPECT().CountPostsByTaxonomyTerm(gomock.Any(), int64(99)).Return(int64(0), nil)
		store.EXPECT().DeleteTaxonomyTermTx(gomock.Any(), int64(99)).Return(db.ErrDefaultTerm)
		recorder := asMock(t, server, editor, http.MethodDelete, "/api/v1/taxonomy/terms/99", nil)
		requireStatus(t, recorder, http.StatusConflict)
		require.Equal(t, "default_term", responseCode(t, recorder))
	})
}

func TestMergeTaxonomyTermsAPI(t *testing.T) {
	tag := db.TaxonomyType{ID: 2, Name: "tag", Public: true}
	category := db.TaxonomyType{ID: 1, Name: "category", Hierarchical: true}
	images := db.TaxonomyTerm{ID: 20, Name: "Images", Slug: "images", TaxonomyTypeID: 2}
	photos := db.TaxonomyTerm{ID: 21, Name: "Photos", Slug: "photos", TaxonomyTypeID: 2}
	guides := db.TaxonomyTerm{ID: 10, Name: "Guides", Slug: "guides", TaxonomyTypeID: 1}
	terms := map[int64]db.TaxonomyTerm{20: images, 21: photos, 10: guides}
	stub := func(store *mockdb.MockStore) {
		store.EXPECT().GetTaxonomyTypeByID(gomock.Any(), gomock.Any()).AnyTimes().DoAndReturn(func(_ any, id int64) (db.TaxonomyType, error) {
			if id == 1 {
				return category, nil
			}
			return tag, nil
		})
		store.EXPECT().GetTaxonomyTerm(gomock.Any(), gomock.Any()).AnyTimes().DoAndReturn(func(_ any, id int64) (db.TaxonomyTerm, error) {
			if term, ok := terms[id]; ok {
				return term, nil
			}
			return db.TaxonomyTerm{}, sql.ErrNoRows
		})
	}

	t.Run("OK", func(t *testing.T) {
		store, server, editor := mockCaller(t, RoleEditor)
		stub(store)
		store.EXPECT().MergeTaxonomyTermsTx(gomock.Any(), gomock.Any()).DoAndReturn(func(_ any, arg db.MergeTaxonomyTermsTxParams) (db.MergeTaxonomyTermsTxResult, error) {
			require.Equal(t, int64(20), arg.TargetID)
			require.Equal(t, []int64{21}, arg.SourceIDs)
			require.Equal(t, []*db.AddRedirectParams{{FromPath: "/tag/photos", ToPath: "/tag/images", StatusCode: 301, Source: db.RedirectSourceMerge, CreatedBy: editor.ID}}, arg.Redirects)
			return db.MergeTaxonomyTermsTxResult{Target: images, MergedIDs: []int64{21}, MovedPosts: 3,
				Redirects: []db.Redirect{{ID: 1, FromPath: "/tag/photos", ToPath: "/tag/images", StatusCode: 301, Source: db.RedirectSourceMerge}}}, nil
		})
		recorder := asMock(t, server, editor, http.MethodPost, "/api/v1/taxonomy/terms/20/merge", gin.H{"source_ids": []int64{21, 21}})
		requireStatus(t, recorder, http.StatusOK)
		var body struct {
			MergedIDs  []int64            `json:"merged_ids"`
			MovedPosts int64              `json:"moved_posts"`
			Redirects  []RedirectResponse `json:"redirects"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
		require.Equal(t, []int64{21}, body.MergedIDs)
		require.EqualValues(t, 3, body.MovedPosts)
		require.Len(t, body.Redirects, 1)
		require.Equal(t, []string{db.ActivityTermsMerged + " term:20"}, activityOf(t, server).verbs())
	})

	for _, tc := range []struct {
		name   string
		path   string
		body   gin.H
		status int
		code   string
	}{
		{"Categories", "/api/v1/taxonomy/terms/10/merge", gin.H{"source_ids": []int64{21}}, http.StatusBadRequest, "merge_not_supported"},
		{"IntoItself", "/api/v1/taxonomy/terms/20/merge", gin.H{"source_ids": []int64{20}}, http.StatusBadRequest, "merge_into_itself"},
		{"OtherTaxonomy", "/api/v1/taxonomy/terms/20/merge", gin.H{"source_ids": []int64{10}}, http.StatusBadRequest, "merge_type_mismatch"},
		{"UnknownSource", "/api/v1/taxonomy/terms/20/merge", gin.H{"source_ids": []int64{404}}, http.StatusNotFound, ""},
		{"UnknownTarget", "/api/v1/taxonomy/terms/404/merge", gin.H{"source_ids": []int64{21}}, http.StatusNotFound, ""},
		{"NoSources", "/api/v1/taxonomy/terms/20/merge", gin.H{"source_ids": []int64{}}, http.StatusBadRequest, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store, server, editor := mockCaller(t, RoleEditor)
			stub(store)
			store.EXPECT().MergeTaxonomyTermsTx(gomock.Any(), gomock.Any()).Times(0)
			recorder := asMock(t, server, editor, http.MethodPost, tc.path, tc.body)
			requireStatus(t, recorder, tc.status)
			if tc.code != "" {
				require.Equal(t, tc.code, responseCode(t, recorder))
			}
		})
	}

	t.Run("DefaultSource", func(t *testing.T) {
		store, server, editor := mockCaller(t, RoleEditor)
		stub(store)
		store.EXPECT().MergeTaxonomyTermsTx(gomock.Any(), gomock.Any()).Return(db.MergeTaxonomyTermsTxResult{}, db.ErrDefaultTerm)
		recorder := asMock(t, server, editor, http.MethodPost, "/api/v1/taxonomy/terms/20/merge", gin.H{"source_ids": []int64{21}})
		requireStatus(t, recorder, http.StatusConflict)
		require.Equal(t, "default_term", responseCode(t, recorder))
	})

	t.Run("ContributorForbidden", func(t *testing.T) {
		store, server, contributor := mockCaller(t, RoleContributor)
		store.EXPECT().MergeTaxonomyTermsTx(gomock.Any(), gomock.Any()).Times(0)
		requireStatus(t, asMock(t, server, contributor, http.MethodPost, "/api/v1/taxonomy/terms/20/merge", gin.H{"source_ids": []int64{21}}), http.StatusForbidden)
	})
}

func TestCreatePostRefusesTwoCategories(t *testing.T) {
	store, server, editor := mockCaller(t, RoleEditor)
	store.EXPECT().CountCategoryTerms(gomock.Any(), []int64{1, 2, 3}).Return(int64(2), nil)
	store.EXPECT().CreatePostWithTaxonomyTermsTx(gomock.Any(), gomock.Any()).Times(0)
	recorder := asMock(t, server, editor, http.MethodPost, "/api/v1/posts", gin.H{
		"title": "Two categories", "url": "https://example.test/x", "author_ids": []int64{editor.ID}, "taxonomy_ids": []int64{1, 2, 3},
	})
	requireStatus(t, recorder, http.StatusBadRequest)
	require.Equal(t, "one_category", responseCode(t, recorder))
}
