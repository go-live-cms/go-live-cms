package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/token"
)

func randomPostMeta(postID int64) db.PostMetum {
	return db.PostMetum{
		ID:        1,
		PostID:    postID,
		MetaKey:   "seo_title",
		MetaValue: sql.NullString{String: "Test SEO Title", Valid: true},
		CreatedAt: time.Now(),
	}
}

func TestGetPostMetaAPI(t *testing.T) {
	postID := int64(1)

	testCases := []struct {
		name          string
		postID        int64
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:   "OK",
			postID: postID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), postID).
					Times(1).
					Return(db.Post{ID: postID}, nil)
				store.EXPECT().
					GetPostMeta(gomock.Any(), postID).
					Times(1).
					Return([]db.PostMetum{randomPostMeta(postID)}, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp map[string]interface{}
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				require.Contains(t, resp, "meta")
			},
		},
		{
			name:   "PostNotFound",
			postID: 999,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), int64(999)).
					Times(1).
					Return(db.Post{}, sql.ErrNoRows)
				store.EXPECT().
					GetPostMeta(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:   "InternalError",
			postID: postID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), postID).
					Times(1).
					Return(db.Post{}, fmt.Errorf("db error"))
				store.EXPECT().
					GetPostMeta(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
		{
			name:   "MetaInternalError",
			postID: postID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), postID).
					Times(1).
					Return(db.Post{ID: postID}, nil)
				store.EXPECT().
					GetPostMeta(gomock.Any(), postID).
					Times(1).
					Return(nil, fmt.Errorf("db error"))
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			url := fmt.Sprintf("/api/v1/posts/%d/meta", tc.postID)
			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestCreateOrUpdatePostMetaAPI(t *testing.T) {
	postID := int64(1)
	meta := randomPostMeta(postID)

	testCases := []struct {
		name          string
		postID        int64
		body          map[string]interface{}
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:   "OK",
			postID: postID,
			body: map[string]interface{}{
				"meta_key":   "seo_title",
				"meta_value": "Test SEO Title",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), postID).
					Times(1).
					Return(db.Post{ID: postID}, nil)
				store.EXPECT().
					UpsertPostMeta(gomock.Any(), gomock.Any()).
					Times(1).
					Return(meta, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp map[string]interface{}
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				require.Contains(t, resp, "meta")
			},
		},
		{
			name:   "NoAuthorization",
			postID: postID,
			body: map[string]interface{}{
				"meta_key":   "seo_title",
				"meta_value": "Test SEO Title",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				// no auth
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), gomock.Any()).
					Times(0)
				store.EXPECT().
					UpsertPostMeta(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name:   "PostNotFound",
			postID: 999,
			body: map[string]interface{}{
				"meta_key":   "seo_title",
				"meta_value": "Test SEO Title",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), int64(999)).
					Times(1).
					Return(db.Post{}, sql.ErrNoRows)
				store.EXPECT().
					UpsertPostMeta(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:   "InvalidBody",
			postID: postID,
			body: map[string]interface{}{
				// missing required meta_key
				"meta_value": "Test SEO Title",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), gomock.Any()).
					Times(0)
				store.EXPECT().
					UpsertPostMeta(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			data, err := json.Marshal(tc.body)
			require.NoError(t, err)

			url := fmt.Sprintf("/api/v1/posts/%d/meta", tc.postID)
			request, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(data))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestDeletePostMetaByKeyAPI(t *testing.T) {
	postID := int64(1)
	metaKey := "seo_title"
	meta := randomPostMeta(postID)

	testCases := []struct {
		name          string
		postID        int64
		metaKey       string
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:    "OK",
			postID:  postID,
			metaKey: metaKey,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), postID).
					Times(1).
					Return(db.Post{ID: postID}, nil)
				store.EXPECT().
					GetPostMetaByKey(gomock.Any(), db.GetPostMetaByKeyParams{
						PostID:  postID,
						MetaKey: metaKey,
					}).
					Times(1).
					Return(meta, nil)
				store.EXPECT().
					DeletePostMeta(gomock.Any(), db.DeletePostMetaParams{
						PostID:  postID,
						MetaKey: metaKey,
					}).
					Times(1).
					Return(nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp map[string]interface{}
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				require.Equal(t, "post meta deleted successfully", resp["message"])
			},
		},
		{
			name:    "NoAuthorization",
			postID:  postID,
			metaKey: metaKey,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				// no auth
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name:    "PostNotFound",
			postID:  999,
			metaKey: metaKey,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), int64(999)).
					Times(1).
					Return(db.Post{}, sql.ErrNoRows)
				store.EXPECT().
					GetPostMetaByKey(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:    "MetaNotFound",
			postID:  postID,
			metaKey: "nonexistent_key",
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), postID).
					Times(1).
					Return(db.Post{ID: postID}, nil)
				store.EXPECT().
					GetPostMetaByKey(gomock.Any(), db.GetPostMetaByKeyParams{
						PostID:  postID,
						MetaKey: "nonexistent_key",
					}).
					Times(1).
					Return(db.PostMetum{}, sql.ErrNoRows)
				store.EXPECT().
					DeletePostMeta(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			url := fmt.Sprintf("/api/v1/posts/%d/meta/%s", tc.postID, tc.metaKey)
			request, err := http.NewRequest(http.MethodDelete, url, nil)
			require.NoError(t, err)

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}
