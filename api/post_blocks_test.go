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
			// Posts that never had blocks store `{}`: clients read doc.blocks_order.length,
			// so the API must not answer null for it (#304).
			name:   "EmptyStoredDocIsWellFormed",
			postID: 1,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPostBlocks(gomock.Any(), int64(1)).
					Times(1).
					Return(db.GetPostBlocksRow{Content: json.RawMessage(`{}`), Revision: 1}, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				require.JSONEq(t, `{"doc":{"doc_version":1,"blocks_order":[],"blocks":{}}}`, recorder.Body.String())
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
			stubRoleLookup(store, db.User{ID: 1, Username: "testuser", Role: RoleContributor})
			// The contributor owns every post here, so canReadPost lets them read it (#393).
			store.EXPECT().GetPost(gomock.Any(), gomock.Any()).DoAndReturn(func(_ context.Context, id int64) (db.Post, error) {
				return db.Post{ID: id, UserID: 1, PostStatus: "draft"}, nil
			}).AnyTimes()

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
					PublishPostTx(gomock.Any(), gomock.Any()).
					Times(1).
					DoAndReturn(func(_ any, arg db.PublishPostTxParams) (db.PublishPostTxResult, error) {
						require.Equal(t, int64(1), arg.PostID)
						require.Equal(t, sql.NullInt64{Int64: 1, Valid: true}, arg.CreatedBy)
						require.False(t, arg.Label.Valid)
						require.False(t, arg.Message.Valid)
						// The content image links are synced in the transaction
						// (#389), from the image blocks in document order.
						require.NotNil(t, arg.ContentMedia)
						require.Equal(t, []db.ContentMediaUse{
							{MediaID: 7, BlockID: "b", BlockType: "image"},
							{MediaID: 3, BlockID: "a", BlockType: "image"},
							{MediaID: 7, BlockID: "c", BlockType: "image"},
						}, arg.ContentMedia(json.RawMessage(
							`{"doc_version":1,"blocks_order":["b","a","c","d"],"blocks":{`+
								`"a":{"type":"image","attrs":{"mediaId":3}},`+
								`"b":{"type":"image","attrs":{"mediaId":7}},`+
								`"c":{"type":"image","attrs":{"mediaId":7}},`+
								`"d":{"type":"paragraph"}}}`)))
						require.Empty(t, arg.ContentMedia(json.RawMessage(`{"blocks":[]}`)))
						return db.PublishPostTxResult{VersionID: 1, VersionNo: 1, BlockDoc: validBlockDoc()}, nil
					})
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
					PublishPostTx(gomock.Any(), gomock.Any()).
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
					PublishPostTx(gomock.Any(), gomock.Any()).
					Times(1).
					Return(db.PublishPostTxResult{}, sql.ErrNoRows)
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
					PublishPostTx(gomock.Any(), gomock.Any()).
					Times(1).
					Return(db.PublishPostTxResult{}, fmt.Errorf("db error"))
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
