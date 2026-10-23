package api

import (
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/util"
)

const testCollabInternalSecret = "test-collab-internal-secret"

// newHocuspocusTestServer is newTestServer with COLLAB_BACKEND=hocuspocus and
// the collab server's internal endpoints at collabURL.
func newHocuspocusTestServer(t *testing.T, store db.Store, collabURL string) *Server {
	t.Helper()
	gin.SetMode(gin.TestMode)
	config := newTestConfig(t)
	config.CollabBackend = util.CollabBackendHocuspocus
	config.CollabInternalURL = collabURL
	config.CollabInternalSecret = testCollabInternalSecret
	server, err := NewServer(config, store)
	require.NoError(t, err)
	return server
}

func internalCollabRequest(t *testing.T, server *Server, method, path string, body []byte, authorization string) *httptest.ResponseRecorder {
	t.Helper()
	request, err := http.NewRequest(method, path, bytes.NewReader(body))
	require.NoError(t, err)
	request.Header.Set("Content-Type", "application/json")
	if authorization != "" {
		request.Header.Set(authorizationHeaderKey, authorization)
	}
	recorder := httptest.NewRecorder()
	server.internalRouter.ServeHTTP(recorder, request)
	return recorder
}

// TestGetInternalPostCollab covers the collab server's load: shared-secret
// auth, 404, and the revision guard that hides a stale Yjs state.
func TestGetInternalPostCollab(t *testing.T) {
	epoch := uuid.New()
	doc := json.RawMessage(`{"doc_version":1,"blocks_order":[],"blocks":{}}`)

	testCases := []struct {
		name          string
		path          string
		authorization string
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(t *testing.T, recorder *httptest.ResponseRecorder)
	}{
		{
			name:          "StateMatchesRevision",
			path:          "/internal/posts/7/collab",
			authorization: "Bearer " + testRoleLookupSecret,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPostCollab(gomock.Any(), int64(7)).Times(1).Return(db.GetPostCollabRow{
					BlockDoc:          doc,
					BlockRevision:     4,
					YdocState:         []byte{1, 2, 3},
					YdocEpoch:         uuid.NullUUID{UUID: epoch, Valid: true},
					YdocBlockRevision: sql.NullInt64{Int64: 4, Valid: true},
				}, nil)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				require.JSONEq(t, fmt.Sprintf(`{"block_doc":%s,"block_revision":4,"ydoc_state":%q,"epoch":%q}`,
					doc, base64.StdEncoding.EncodeToString([]byte{1, 2, 3}), epoch), recorder.Body.String())
			},
		},
		{
			name:          "StaleStateOmitted",
			path:          "/internal/posts/7/collab",
			authorization: "Bearer " + testRoleLookupSecret,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPostCollab(gomock.Any(), int64(7)).Times(1).Return(db.GetPostCollabRow{
					BlockDoc:          doc,
					BlockRevision:     5,
					YdocState:         []byte{1, 2, 3},
					YdocEpoch:         uuid.NullUUID{UUID: epoch, Valid: true},
					YdocBlockRevision: sql.NullInt64{Int64: 4, Valid: true},
				}, nil)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				require.JSONEq(t, fmt.Sprintf(`{"block_doc":%s,"block_revision":5}`, doc), recorder.Body.String())
			},
		},
		{
			name:          "NoState",
			path:          "/internal/posts/7/collab",
			authorization: "Bearer " + testRoleLookupSecret,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPostCollab(gomock.Any(), int64(7)).Times(1).Return(db.GetPostCollabRow{
					BlockDoc: doc, BlockRevision: 1,
				}, nil)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				require.JSONEq(t, fmt.Sprintf(`{"block_doc":%s,"block_revision":1}`, doc), recorder.Body.String())
			},
		},
		{
			name:          "MissingSecret",
			path:          "/internal/posts/7/collab",
			authorization: "",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPostCollab(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			// The API -> collab secret is not the collab -> API one.
			name:          "CollabInternalSecretIsNotAccepted",
			path:          "/internal/posts/7/collab",
			authorization: "Bearer " + testCollabInternalSecret,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPostCollab(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name:          "NotFound",
			path:          "/internal/posts/7/collab",
			authorization: "Bearer " + testRoleLookupSecret,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPostCollab(gomock.Any(), int64(7)).Times(1).Return(db.GetPostCollabRow{}, sql.ErrNoRows)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:          "InvalidID",
			path:          "/internal/posts/abc/collab",
			authorization: "Bearer " + testRoleLookupSecret,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPostCollab(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name:          "DatabaseError",
			path:          "/internal/posts/7/collab",
			authorization: "Bearer " + testRoleLookupSecret,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPostCollab(gomock.Any(), int64(7)).Times(1).Return(db.GetPostCollabRow{}, errors.New("db down"))
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)

			// Reads work under either backend.
			server := newTestServer(t, store)
			tc.checkResponse(t, internalCollabRequest(t, server, http.MethodGet, tc.path, nil, tc.authorization))
		})
	}
}

func collabStoreBody(t *testing.T, fields map[string]any) []byte {
	t.Helper()
	body := map[string]any{
		"state": base64.StdEncoding.EncodeToString([]byte{1, 2, 3}),
		"epoch": "6f1c5f4e-9a59-4d55-9a4d-2b8f0d9e1a01",
		"block_doc": map[string]any{
			"doc_version":  1,
			"blocks_order": []string{"a", "img", "a"},
			"blocks": map[string]any{
				"a":   map[string]any{"type": "paragraph"},
				"img": map[string]any{"type": "image", "attrs": map[string]any{"mediaId": 12, "src": "javascript:alert(1)"}},
			},
		},
		"last_editor_id": 3,
		"base_revision":  4,
	}
	for k, v := range fields {
		if v == nil {
			delete(body, k)
		} else {
			body[k] = v
		}
	}
	data, err := json.Marshal(body)
	require.NoError(t, err)
	return data
}

// TestPutInternalPostCollab covers the collab server's store: auth, the
// backend flag, body checks, and how the transaction's result maps to
// responses.
func TestPutInternalPostCollab(t *testing.T) {
	const path = "/internal/posts/7/collab"
	auth := "Bearer " + testRoleLookupSecret

	testCases := []struct {
		name          string
		body          []byte
		authorization string
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(t *testing.T, recorder *httptest.ResponseRecorder)
	}{
		{
			name:          "OK",
			body:          collabStoreBody(t, nil),
			authorization: auth,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().StorePostCollabTx(gomock.Any(), gomock.Any()).Times(1).
					DoAndReturn(func(_ any, arg db.StorePostCollabTxParams) (db.StorePostCollabTxResult, error) {
						require.Equal(t, int64(7), arg.PostID)
						require.Equal(t, []byte{1, 2, 3}, arg.State)
						require.Equal(t, "6f1c5f4e-9a59-4d55-9a4d-2b8f0d9e1a01", arg.Epoch.String())
						require.Equal(t, sql.NullInt64{Int64: 3, Valid: true}, arg.LastEditorID)
						require.Equal(t, sql.NullInt64{Int64: 4, Valid: true}, arg.BaseRevision)
						require.Equal(t, []int64{12}, arg.MediaIDs)

						// Structural check: duplicate ids deduplicated, and the
						// same sanitizing PUT /blocks does.
						var doc BlockDocV1
						require.NoError(t, json.Unmarshal(arg.BlockDoc, &doc))
						require.Equal(t, []string{"a", "img"}, doc.BlocksOrder)
						require.NotContains(t, string(arg.BlockDoc), "javascript:")
						return db.StorePostCollabTxResult{BlockRevision: 5}, nil
					})
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
				require.JSONEq(t, `{"block_revision":5,"epoch":"6f1c5f4e-9a59-4d55-9a4d-2b8f0d9e1a01"}`, recorder.Body.String())
			},
		},
		{
			name:          "StateOnly",
			body:          collabStoreBody(t, map[string]any{"block_doc": nil, "last_editor_id": nil}),
			authorization: auth,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().StorePostCollabTx(gomock.Any(), gomock.Any()).Times(1).
					DoAndReturn(func(_ any, arg db.StorePostCollabTxParams) (db.StorePostCollabTxResult, error) {
						require.Nil(t, arg.BlockDoc)
						require.Nil(t, arg.MediaIDs)
						require.Equal(t, sql.NullInt64{Int64: 4, Valid: true}, arg.BaseRevision)
						require.False(t, arg.LastEditorID.Valid)
						return db.StorePostCollabTxResult{BlockRevision: 4}, nil
					})
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
			},
		},
		{
			// Without the revision it was loaded at, a state-only store could
			// stamp a stale state as current and defeat the revision guard.
			name:          "StateOnlyNeedsBaseRevision",
			body:          collabStoreBody(t, map[string]any{"block_doc": nil, "base_revision": nil}),
			authorization: auth,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().StorePostCollabTx(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code, recorder.Body.String())
			},
		},
		{
			name:          "MissingSecret",
			body:          collabStoreBody(t, nil),
			authorization: "",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().StorePostCollabTx(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name:          "WrongSecret",
			body:          collabStoreBody(t, nil),
			authorization: "Bearer " + testCollabInternalSecret,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().StorePostCollabTx(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name:          "NotFound",
			body:          collabStoreBody(t, nil),
			authorization: auth,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().StorePostCollabTx(gomock.Any(), gomock.Any()).Times(1).Return(db.StorePostCollabTxResult{}, sql.ErrNoRows)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:          "RevisionConflict",
			body:          collabStoreBody(t, nil),
			authorization: auth,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().StorePostCollabTx(gomock.Any(), gomock.Any()).Times(1).Return(db.StorePostCollabTxResult{}, db.ErrCollabRevisionConflict)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusConflict, recorder.Code)
			},
		},
		{
			name:          "DatabaseError",
			body:          collabStoreBody(t, nil),
			authorization: auth,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().StorePostCollabTx(gomock.Any(), gomock.Any()).Times(1).Return(db.StorePostCollabTxResult{}, errors.New("tx failed"))
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
		{
			name:          "Oversize",
			body:          collabStoreBody(t, map[string]any{"state": base64.StdEncoding.EncodeToString(make([]byte, collabStoreBodyLimit))}),
			authorization: auth,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().StorePostCollabTx(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusRequestEntityTooLarge, recorder.Code)
			},
		},
		{
			// Within the body limit, but over what PUT /blocks accepts.
			name: "OversizeBlockDoc",
			body: collabStoreBody(t, map[string]any{"block_doc": map[string]any{
				"doc_version":  1,
				"blocks_order": []string{"a"},
				"blocks":       map[string]any{"a": map[string]any{"type": "paragraph", "text": strings.Repeat("x", int(blockDocBodyLimit))}},
			}}),
			authorization: auth,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().StorePostCollabTx(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusRequestEntityTooLarge, recorder.Code)
			},
		},
		{
			name:          "MissingState",
			body:          collabStoreBody(t, map[string]any{"state": ""}),
			authorization: auth,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().StorePostCollabTx(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name:          "InvalidEpoch",
			body:          collabStoreBody(t, map[string]any{"epoch": "not-a-uuid"}),
			authorization: auth,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().StorePostCollabTx(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name: "BlocksOrderReferencesMissingBlock",
			body: collabStoreBody(t, map[string]any{"block_doc": map[string]any{
				"doc_version": 1, "blocks_order": []string{"ghost"}, "blocks": map[string]any{},
			}}),
			authorization: auth,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().StorePostCollabTx(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
				require.Contains(t, recorder.Body.String(), "ghost")
			},
		},
		{
			name: "UnsupportedDocVersion",
			body: collabStoreBody(t, map[string]any{"block_doc": map[string]any{
				"doc_version": 2, "blocks_order": []string{}, "blocks": map[string]any{},
			}}),
			authorization: auth,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().StorePostCollabTx(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name:          "UnknownField",
			body:          collabStoreBody(t, map[string]any{"title": "x"}),
			authorization: auth,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().StorePostCollabTx(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)

			server := newHocuspocusTestServer(t, store, "http://collab.invalid")
			tc.checkResponse(t, internalCollabRequest(t, server, http.MethodPut, path, tc.body, tc.authorization))
		})
	}
}

// Under y-websocket the editor's REST autosave owns block_doc; the internal
// store must not become a second writer.
func TestPutInternalPostCollabRequiresHocuspocus(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	store.EXPECT().StorePostCollabTx(gomock.Any(), gomock.Any()).Times(0)

	server := newTestServer(t, store)
	recorder := internalCollabRequest(t, server, http.MethodPut, "/internal/posts/7/collab",
		collabStoreBody(t, nil), "Bearer "+testRoleLookupSecret)
	require.Equal(t, http.StatusConflict, recorder.Code)
}

// The collab routes live on the internal listener only.
func TestInternalCollabRoutesNotOnPublicRouter(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	server := newHocuspocusTestServer(t, store, "http://collab.invalid")

	for _, path := range []string{"/internal/posts/7/collab", "/api/v1/internal/posts/7/collab"} {
		for _, method := range []string{http.MethodGet, http.MethodPut} {
			request, err := http.NewRequest(method, path, nil)
			require.NoError(t, err)
			request.Header.Set(authorizationHeaderKey, "Bearer "+testRoleLookupSecret)
			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, request)
			require.Equal(t, http.StatusNotFound, recorder.Code, method+" "+path)
		}
	}
}

func TestNewServerHocuspocusRequiresCollabInternalConfig(t *testing.T) {
	for _, tc := range []struct{ name, url, secret string }{
		{name: "MissingURL", secret: testCollabInternalSecret},
		{name: "MissingSecret", url: "http://collab:1235"},
		{name: "BlankSecret", url: "http://collab:1235", secret: "  "},
	} {
		t.Run(tc.name, func(t *testing.T) {
			config := newTestConfig(t)
			config.CollabBackend = util.CollabBackendHocuspocus
			config.CollabInternalURL = tc.url
			config.CollabInternalSecret = tc.secret
			_, err := NewServer(config, nil)
			require.ErrorContains(t, err, "COLLAB_INTERNAL_URL")
		})
	}

	// y-websocket keeps them optional (squash is just skipped).
	_, err := NewServer(newTestConfig(t), nil)
	require.NoError(t, err)
}
