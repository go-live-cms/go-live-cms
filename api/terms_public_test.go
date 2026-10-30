package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

func publicTermRow() db.GetPublicTermRow {
	return db.GetPublicTermRow{
		ID:            7,
		Name:          "Guides",
		Slug:          "guides",
		Description:   sql.NullString{String: "How-tos.", Valid: true},
		TaxonomyName:  "category",
		TaxonomyLabel: "Categories",
		Hierarchical:  true,
	}
}

func termPostRows(n int) []db.ListPublishedPostsByTermRow {
	rows := make([]db.ListPublishedPostsByTermRow, n)
	for i := range rows {
		rows[i] = db.ListPublishedPostsByTermRow{ID: int64(i + 1), Title: "Post", PostType: "post", PostStatus: "published", Authors: json.RawMessage(`[]`)}
	}
	return rows
}

func TestListPublicTermPostsAPI(t *testing.T) {
	termParams := db.GetPublicTermParams{Taxonomy: "category", Slug: "guides"}
	listParams := func(offset, limit int32) db.ListPublishedPostsByTermParams {
		return db.ListPublishedPostsByTermParams{TermID: 7, OffsetCount: offset, LimitCount: limit}
	}

	testCases := []struct {
		name       string
		url        string
		expect     func(store *mockdb.MockStore)
		wantStatus int
		wantPage   pageInfo
		wantCount  int
	}{
		{
			name: "FirstPage",
			url:  "/public/taxonomies/category/terms/guides/posts",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(perPageSetting(10), nil)
				store.EXPECT().GetPublicTerm(gomock.Any(), termParams).Return(publicTermRow(), nil)
				store.EXPECT().CountPublishedPostsByTerm(gomock.Any(), int64(7)).Return(int64(14), nil)
				store.EXPECT().ListPublishedPostsByTerm(gomock.Any(), listParams(0, 10)).Return(termPostRows(10), nil)
			},
			wantStatus: http.StatusOK,
			wantPage:   pageInfo{Page: 1, PerPage: 10, Total: 14, TotalPages: 2},
			wantCount:  10,
		},
		{
			name: "LastPage",
			url:  "/public/taxonomies/category/terms/guides/posts?page=2",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(perPageSetting(10), nil)
				store.EXPECT().GetPublicTerm(gomock.Any(), termParams).Return(publicTermRow(), nil)
				store.EXPECT().CountPublishedPostsByTerm(gomock.Any(), int64(7)).Return(int64(14), nil)
				store.EXPECT().ListPublishedPostsByTerm(gomock.Any(), listParams(10, 10)).Return(termPostRows(4), nil)
			},
			wantStatus: http.StatusOK,
			wantPage:   pageInfo{Page: 2, PerPage: 10, Total: 14, TotalPages: 2},
			wantCount:  4,
		},
		{
			// A term with no posts still has its first page.
			name: "EmptyTerm",
			url:  "/public/taxonomies/category/terms/guides/posts",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(perPageSetting(10), nil)
				store.EXPECT().GetPublicTerm(gomock.Any(), termParams).Return(publicTermRow(), nil)
				store.EXPECT().CountPublishedPostsByTerm(gomock.Any(), int64(7)).Return(int64(0), nil)
				store.EXPECT().ListPublishedPostsByTerm(gomock.Any(), listParams(0, 10)).Return(termPostRows(0), nil)
			},
			wantStatus: http.StatusOK,
			wantPage:   pageInfo{Page: 1, PerPage: 10, Total: 0, TotalPages: 0},
			wantCount:  0,
		},
		{
			name: "PastTheEnd",
			url:  "/public/taxonomies/category/terms/guides/posts?page=3",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(perPageSetting(10), nil)
				store.EXPECT().GetPublicTerm(gomock.Any(), termParams).Return(publicTermRow(), nil)
				store.EXPECT().CountPublishedPostsByTerm(gomock.Any(), int64(7)).Return(int64(14), nil)
				store.EXPECT().ListPublishedPostsByTerm(gomock.Any(), gomock.Any()).Times(0)
			},
			wantStatus: http.StatusNotFound,
		},
		{
			// GetPublicTerm answers no row for an unknown slug, an unknown
			// taxonomy and a non-public one alike.
			name: "UnknownOrNonPublicTerm",
			url:  "/public/taxonomies/category/terms/guides/posts",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(perPageSetting(10), nil)
				store.EXPECT().GetPublicTerm(gomock.Any(), termParams).Return(db.GetPublicTermRow{}, sql.ErrNoRows)
				store.EXPECT().CountPublishedPostsByTerm(gomock.Any(), gomock.Any()).Times(0)
			},
			wantStatus: http.StatusNotFound,
		},
		{
			name: "InvalidPage",
			url:  "/public/taxonomies/category/terms/guides/posts?page=0",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetPublicTerm(gomock.Any(), gomock.Any()).Times(0)
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "TermLookupError",
			url:  "/public/taxonomies/category/terms/guides/posts",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(perPageSetting(10), nil)
				store.EXPECT().GetPublicTerm(gomock.Any(), termParams).Return(db.GetPublicTermRow{}, errors.New("boom"))
			},
			wantStatus: http.StatusInternalServerError,
		},
		{
			name: "CountError",
			url:  "/public/taxonomies/category/terms/guides/posts",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(perPageSetting(10), nil)
				store.EXPECT().GetPublicTerm(gomock.Any(), termParams).Return(publicTermRow(), nil)
				store.EXPECT().CountPublishedPostsByTerm(gomock.Any(), int64(7)).Return(int64(0), errors.New("boom"))
			},
			wantStatus: http.StatusInternalServerError,
		},
		{
			name: "ListError",
			url:  "/public/taxonomies/category/terms/guides/posts",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(perPageSetting(10), nil)
				store.EXPECT().GetPublicTerm(gomock.Any(), termParams).Return(publicTermRow(), nil)
				store.EXPECT().CountPublishedPostsByTerm(gomock.Any(), int64(7)).Return(int64(3), nil)
				store.EXPECT().ListPublishedPostsByTerm(gomock.Any(), listParams(0, 10)).Return(nil, errors.New("boom"))
			},
			wantStatus: http.StatusInternalServerError,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			tc.expect(store)

			recorder := getPublic(t, store, tc.url)
			require.Equal(t, tc.wantStatus, recorder.Code, recorder.Body.String())
			if tc.wantStatus != http.StatusOK {
				return
			}
			var body struct {
				Term       map[string]any   `json:"term"`
				Posts      []map[string]any `json:"posts"`
				Pagination pageInfo         `json:"pagination"`
			}
			require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
			require.Equal(t, tc.wantPage, body.Pagination)
			require.Len(t, body.Posts, tc.wantCount)
			require.Equal(t, map[string]any{
				"id": float64(7), "name": "Guides", "slug": "guides", "description": "How-tos.",
				"taxonomy": "category", "taxonomy_label": "Categories", "hierarchical": true,
			}, body.Term)
		})
	}
}

func TestListPublicTermsAPI(t *testing.T) {
	changed := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)

	t.Run("OK", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().ListPublicTerms(gomock.Any(), db.ListPublicTermsParams{LimitCount: 1000, OffsetCount: 0}).
			Return([]db.ListPublicTermsRow{{TaxonomyName: "tag", Slug: "editor", LastModified: changed}}, nil)

		recorder := getPublic(t, store, "/public/terms")
		require.Equal(t, http.StatusOK, recorder.Code)
		require.JSONEq(t, `{"terms":[{"taxonomy":"tag","slug":"editor","last_modified":"2026-10-27T12:00:00Z"}]}`, recorder.Body.String())
	})

	t.Run("Paged", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().ListPublicTerms(gomock.Any(), db.ListPublicTermsParams{LimitCount: 50, OffsetCount: 100}).Return([]db.ListPublicTermsRow{}, nil)

		recorder := getPublic(t, store, "/public/terms?limit=50&offset=100")
		require.Equal(t, http.StatusOK, recorder.Code)
		require.JSONEq(t, `{"terms":[]}`, recorder.Body.String())
	})

	t.Run("BadLimit", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		recorder := getPublic(t, store, "/public/terms?limit=x")
		require.Equal(t, http.StatusBadRequest, recorder.Code)
	})

	t.Run("Error", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().ListPublicTerms(gomock.Any(), gomock.Any()).Return(nil, errors.New("boom"))
		recorder := getPublic(t, store, "/public/terms")
		require.Equal(t, http.StatusInternalServerError, recorder.Code)
	})
}
