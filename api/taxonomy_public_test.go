package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang/mock/gomock"
	"github.com/sqlc-dev/pqtype"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

func randomGetTaxonomyTermBySlugRow(term db.TaxonomyTerm, typeName string) db.GetTaxonomyTermBySlugRow {
	return db.GetTaxonomyTermBySlugRow{
		ID:               term.ID,
		Name:             term.Name,
		Slug:             term.Slug,
		Description:      term.Description,
		ParentID:         term.ParentID,
		TaxonomyTypeID:   term.TaxonomyTypeID,
		SortOrder:        term.SortOrder,
		Meta:             pqtype.NullRawMessage{Valid: false},
		CreatedAt:        time.Now(),
		TaxonomyTypeName: typeName,
		Hierarchical:     false,
	}
}

func randomGetPostTaxonomyTermsRow(term db.TaxonomyTerm, typeName string) db.GetPostTaxonomyTermsRow {
	return db.GetPostTaxonomyTermsRow{
		ID:               term.ID,
		Name:             term.Name,
		Slug:             term.Slug,
		Description:      term.Description,
		ParentID:         term.ParentID,
		TaxonomyTypeID:   term.TaxonomyTypeID,
		SortOrder:        term.SortOrder,
		Meta:             pqtype.NullRawMessage{Valid: false},
		CreatedAt:        time.Now(),
		TaxonomyTypeName: typeName,
		Hierarchical:     false,
	}
}

// TestGetTaxonomyTermBySlugAPI tests GET /taxonomy/terms/slug/:slug
func TestGetTaxonomyTermBySlugAPI(t *testing.T) {
	term := randomTaxonomyTerm()
	row := randomGetTaxonomyTermBySlugRow(term, "category")

	testCases := []struct {
		name          string
		slug          string
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name: "OK",
			slug: term.Slug,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyTermBySlug(gomock.Any(), term.Slug).
					Times(1).
					Return(row, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp map[string]interface{}
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				tt := resp["taxonomy_term"].(map[string]interface{})
				require.Equal(t, term.Name, tt["name"])
				require.Equal(t, term.Slug, tt["slug"])
			},
		},
		{
			name: "NotFound",
			slug: term.Slug,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyTermBySlug(gomock.Any(), term.Slug).
					Times(1).
					Return(db.GetTaxonomyTermBySlugRow{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name: "InternalError",
			slug: term.Slug,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyTermBySlug(gomock.Any(), term.Slug).
					Times(1).
					Return(db.GetTaxonomyTermBySlugRow{}, sql.ErrConnDone)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			url := fmt.Sprintf("/api/v1/taxonomy/terms/slug/%s", tc.slug)
			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

// TestGetTaxonomyTermPostsAPI tests GET /taxonomy/terms/:id/posts
func TestGetTaxonomyTermPostsAPI(t *testing.T) {
	term := randomTaxonomyTerm()
	user := randomUserForPosts()
	post := randomPost(user)

	testCases := []struct {
		name          string
		termID        int64
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:   "OK",
			termID: term.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyTerm(gomock.Any(), term.ID).
					Times(1).
					Return(term, nil)
				store.EXPECT().
					GetPostsByTaxonomyTerm(gomock.Any(), gomock.Any()).
					Times(1).
					Return([]db.Post{post}, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp map[string]interface{}
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				posts := resp["posts"].([]interface{})
				require.Len(t, posts, 1)
			},
		},
		{
			name:   "TermNotFound",
			termID: term.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyTerm(gomock.Any(), term.ID).
					Times(1).
					Return(db.TaxonomyTerm{}, sql.ErrNoRows)
				store.EXPECT().GetPostsByTaxonomyTerm(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:   "InvalidID",
			termID: 0,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetTaxonomyTerm(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name:   "InternalError",
			termID: term.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyTerm(gomock.Any(), term.ID).
					Times(1).
					Return(term, nil)
				store.EXPECT().
					GetPostsByTaxonomyTerm(gomock.Any(), gomock.Any()).
					Times(1).
					Return(nil, sql.ErrConnDone)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			var url string
			if tc.name == "InvalidID" {
				url = "/api/v1/taxonomy/terms/abc/posts"
			} else {
				url = fmt.Sprintf("/api/v1/taxonomy/terms/%d/posts", tc.termID)
			}
			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

// TestGetPostTaxonomyTermsAPI tests GET /posts/:id/taxonomies (and /taxonomy-terms)
func TestGetPostTaxonomyTermsAPI(t *testing.T) {
	user := randomUserForPosts()
	post := randomPost(user)
	term := randomTaxonomyTerm()
	termRow := randomGetPostTaxonomyTermsRow(term, "category")

	testCases := []struct {
		name          string
		postID        int64
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:   "OK",
			postID: post.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), post.ID).
					Times(1).
					Return(post, nil)
				store.EXPECT().
					GetPostTaxonomyTerms(gomock.Any(), post.ID).
					Times(1).
					Return([]db.GetPostTaxonomyTermsRow{termRow}, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp map[string]interface{}
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				terms := resp["taxonomy_terms"].([]interface{})
				require.Len(t, terms, 1)
			},
		},
		{
			name:   "EmptyTerms",
			postID: post.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), post.ID).
					Times(1).
					Return(post, nil)
				store.EXPECT().
					GetPostTaxonomyTerms(gomock.Any(), post.ID).
					Times(1).
					Return([]db.GetPostTaxonomyTermsRow{}, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp map[string]interface{}
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				terms := resp["taxonomy_terms"].([]interface{})
				require.Len(t, terms, 0)
			},
		},
		{
			name:   "PostNotFound",
			postID: post.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), post.ID).
					Times(1).
					Return(db.Post{}, sql.ErrNoRows)
				store.EXPECT().GetPostTaxonomyTerms(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:   "InternalError",
			postID: post.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), post.ID).
					Times(1).
					Return(db.Post{}, sql.ErrConnDone)
				store.EXPECT().GetPostTaxonomyTerms(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			url := fmt.Sprintf("/api/v1/posts/%d/taxonomies", tc.postID)
			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

// TestGetPublicPostBlocksAPI tests GET /public/posts/:id/blocks
func TestGetPublicPostBlocksAPI(t *testing.T) {
	publishedDoc := json.RawMessage(`{"doc_version":1,"blocks_order":["b1"],"blocks":{"b1":{"type":"paragraph","content":"hello"}}}`)

	testCases := []struct {
		name          string
		postID        int64
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:   "OK",
			postID: 1,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPublishedPostBlocks(gomock.Any(), int64(1)).
					Times(1).
					Return(pqtype.NullRawMessage{RawMessage: publishedDoc, Valid: true}, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp BlockDocResponse
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				require.Equal(t, 1, resp.Doc.DocVersion)
			},
		},
		{
			name:   "NoPublishedContent",
			postID: 1,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPublishedPostBlocks(gomock.Any(), int64(1)).
					Times(1).
					Return(pqtype.NullRawMessage{Valid: false}, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp BlockDocResponse
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				require.Equal(t, 1, resp.Doc.DocVersion)
				require.Empty(t, resp.Doc.BlocksOrder)
			},
		},
		{
			name:   "NotFound",
			postID: 1,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPublishedPostBlocks(gomock.Any(), int64(1)).
					Times(1).
					Return(pqtype.NullRawMessage{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:   "InvalidID",
			postID: 0,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPublishedPostBlocks(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name:   "InternalError",
			postID: 1,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPublishedPostBlocks(gomock.Any(), int64(1)).
					Times(1).
					Return(pqtype.NullRawMessage{}, sql.ErrConnDone)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			var url string
			if tc.name == "InvalidID" {
				url = "/public/posts/abc/blocks"
			} else {
				url = fmt.Sprintf("/public/posts/%d/blocks", tc.postID)
			}
			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}
