package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
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
	"github.com/go-live-cms/go-live-cms/token"
)

// validBlockDoc returns a minimal valid Block Spec v1 JSON document
func validBlockDoc() json.RawMessage {
	return json.RawMessage(`{"doc_version":1,"blocks_order":[],"blocks":{}}`)
}

func TestGetPostBlocksAPI(t *testing.T) {
	testCases := []struct {
		name          string
		postID        int64
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:   "OK",
			postID: 1,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPostBlocks(gomock.Any(), int64(1)).
					Times(1).
					Return(db.GetPostBlocksRow{
						Content:  validBlockDoc(),
						Revision: 1,
					}, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp map[string]interface{}
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				require.Contains(t, resp, "doc")
				require.Equal(t, "1", recorder.Header().Get("X-Revision"))
			},
		},
		{
			name:   "NotFound",
			postID: 999,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPostBlocks(gomock.Any(), int64(999)).
					Times(1).
					Return(db.GetPostBlocksRow{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:   "InternalError",
			postID: 1,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPostBlocks(gomock.Any(), int64(1)).
					Times(1).
					Return(db.GetPostBlocksRow{}, fmt.Errorf("connection failed"))
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
		{
			name:   "NoAuthorization",
			postID: 1,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				// no auth header — intentionally left empty
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPostBlocks(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
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

			url := fmt.Sprintf("/api/v1/posts/%d/blocks", tc.postID)
			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestUpdatePostBlocksAPI(t *testing.T) {
	updatedContent := validBlockDoc()

	testCases := []struct {
		name          string
		postID        int64
		ifMatch       string
		body          gin.H
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:    "OK",
			postID:  1,
			ifMatch: "1",
			body: gin.H{
				"doc": gin.H{
					"doc_version":  1,
					"blocks_order": []string{},
					"blocks":       gin.H{},
				},
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					UpdatePostBlocksIfRevisionMatches(gomock.Any(), gomock.Any()).
					Times(1).
					Return(db.UpdatePostBlocksIfRevisionMatchesRow{
						Content:  updatedContent,
						Revision: 2,
					}, nil)
				store.EXPECT().
					GetMediaByPostWithOrder(gomock.Any(), int64(1)).
					Times(1).
					Return([]db.GetMediaByPostWithOrderRow{}, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				require.Equal(t, "2", recorder.Header().Get("X-Revision"))
			},
		},
		{
			name:    "NoAuthorization",
			postID:  1,
			ifMatch: "1",
			body: gin.H{
				"doc": gin.H{
					"doc_version":  1,
					"blocks_order": []string{},
					"blocks":       gin.H{},
				},
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				// no auth
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					UpdatePostBlocksIfRevisionMatches(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name:    "MissingIfMatch",
			postID:  1,
			ifMatch: "", // empty → handler returns 400
			body: gin.H{
				"doc": gin.H{
					"doc_version":  1,
					"blocks_order": []string{},
					"blocks":       gin.H{},
				},
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					UpdatePostBlocksIfRevisionMatches(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name:    "InvalidIfMatch",
			postID:  1,
			ifMatch: "not-a-number",
			body: gin.H{
				"doc": gin.H{
					"doc_version":  1,
					"blocks_order": []string{},
					"blocks":       gin.H{},
				},
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					UpdatePostBlocksIfRevisionMatches(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name:    "RevisionMismatch",
			postID:  1,
			ifMatch: "5",
			body: gin.H{
				"doc": gin.H{
					"doc_version":  1,
					"blocks_order": []string{},
					"blocks":       gin.H{},
				},
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					UpdatePostBlocksIfRevisionMatches(gomock.Any(), gomock.Any()).
					Times(1).
					Return(db.UpdatePostBlocksIfRevisionMatchesRow{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusPreconditionFailed, recorder.Code)
			},
		},
		{
			name:    "InvalidDocVersion",
			postID:  1,
			ifMatch: "1",
			body: gin.H{
				"doc": gin.H{
					"doc_version":  2, // unsupported
					"blocks_order": []string{},
					"blocks":       gin.H{},
				},
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					UpdatePostBlocksIfRevisionMatches(gomock.Any(), gomock.Any()).
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
			stubRoleLookup(store, db.User{ID: 1, Username: "testuser", Role: "editor"})

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			data, err := json.Marshal(tc.body)
			require.NoError(t, err)

			url := fmt.Sprintf("/api/v1/posts/%d/blocks", tc.postID)
			request, err := http.NewRequest(http.MethodPut, url, bytes.NewReader(data))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")

			if tc.ifMatch != "" {
				request.Header.Set("If-Match", tc.ifMatch)
			}

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

// TestUpdatePostBlocksSanitizesOnSave verifies the sanitizer (#188) runs in the
// save path: a javascript: link href in the posted block doc must be stripped
// before the document is persisted.
func TestUpdatePostBlocksSanitizesOnSave(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	store := mockdb.NewMockStore(ctrl)

	body := `{"doc":{"doc_version":1,"blocks_order":["b1"],"blocks":{"b1":{"id":"b1","type":"paragraph","version":1,"attrs":{"pm":{"type":"paragraph","content":[{"type":"text","text":"click","marks":[{"type":"link","attrs":{"href":"javascript:alert(1)"}}]}]}}}}}}`

	store.EXPECT().
		UpdatePostBlocksIfRevisionMatches(gomock.Any(), gomock.Any()).
		DoAndReturn(func(_ context.Context, params db.UpdatePostBlocksIfRevisionMatchesParams) (db.UpdatePostBlocksIfRevisionMatchesRow, error) {
			require.NotContains(t, string(params.BlockDoc), "javascript:",
				"sanitizer must strip the javascript: href before persisting")
			return db.UpdatePostBlocksIfRevisionMatchesRow{Content: params.BlockDoc, Revision: 2}, nil
		}).
		Times(1)

	// syncPostMediaAssociations runs after the save; no images → just lists media.
	store.EXPECT().
		GetMediaByPostWithOrder(gomock.Any(), int64(1)).
		Return([]db.GetMediaByPostWithOrderRow{}, nil).
		Times(1)

	server := newTestServer(t, store)
	recorder := httptest.NewRecorder()

	request, err := http.NewRequest(http.MethodPut, "/api/v1/posts/1/blocks", bytes.NewReader([]byte(body)))
	require.NoError(t, err)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("If-Match", "1")
	addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)

	server.router.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusOK, recorder.Code)
}

func TestPublishPostAPI(t *testing.T) {
	testCases := []struct {
		name          string
		postID        int64
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:   "OK",
			postID: 1,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPostBlocks(gomock.Any(), int64(1)).
					Times(1).
					Return(db.GetPostBlocksRow{
						Content:  validBlockDoc(),
						Revision: 1,
					}, nil)
				store.EXPECT().
					GetNextVersionNoForPost(gomock.Any(), int64(1)).
					Times(1).
					Return(int32(1), nil)
				store.EXPECT().
					InsertPostVersion(gomock.Any(), gomock.Any()).
					Times(1).
					Return(db.InsertPostVersionRow{ID: 1, VersionNo: 1}, nil)
				store.EXPECT().
					SetPublishedVersionOnPost(gomock.Any(), gomock.Any()).
					Times(1).
					Return(nil)
				store.EXPECT().
					GetMediaByPostWithOrder(gomock.Any(), int64(1)).
					Times(1).
					Return([]db.GetMediaByPostWithOrderRow{}, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp PublishResponse
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				require.Equal(t, int64(1), resp.VersionID)
				require.Equal(t, int32(1), resp.VersionNo)
			},
		},
		{
			name:   "NoAuthorization",
			postID: 1,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				// no auth
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPostBlocks(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name:   "PostNotFound",
			postID: 999,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPostBlocks(gomock.Any(), int64(999)).
					Times(1).
					Return(db.GetPostBlocksRow{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:   "InternalError",
			postID: 1,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPostBlocks(gomock.Any(), int64(1)).
					Times(1).
					Return(db.GetPostBlocksRow{
						Content:  validBlockDoc(),
						Revision: 1,
					}, nil)
				store.EXPECT().
					GetNextVersionNoForPost(gomock.Any(), int64(1)).
					Times(1).
					Return(int32(0), fmt.Errorf("db error"))
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
			stubRoleLookup(store, db.User{ID: 1, Username: "testuser", Role: "editor"})

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			url := fmt.Sprintf("/api/v1/posts/%d/publish", tc.postID)
			request, err := http.NewRequest(http.MethodPost, url, bytes.NewReader([]byte(`{}`)))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}
