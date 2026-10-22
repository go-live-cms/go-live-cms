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
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// versionsTestCase drives one request against the revisions/unpublish routes.
type versionsTestCase struct {
	name          string
	role          string // "" = no Authorization header
	url           string
	method        string
	buildStubs    func(store *mockdb.MockStore)
	checkResponse func(t *testing.T, recorder *httptest.ResponseRecorder)
}

func runVersionsTestCases(t *testing.T, testCases []versionsTestCase) {
	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)
			stubRoleLookup(store, db.User{ID: 1, Username: "testuser", Role: tc.role})

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			request, err := http.NewRequest(tc.method, tc.url, nil)
			require.NoError(t, err)
			if tc.role != "" {
				addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			}

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(t, recorder)
		})
	}
}

func expectStatus(code int) func(t *testing.T, recorder *httptest.ResponseRecorder) {
	return func(t *testing.T, recorder *httptest.ResponseRecorder) {
		require.Equal(t, code, recorder.Code, recorder.Body.String())
	}
}

func TestListPostVersionsAPI(t *testing.T) {
	createdAt := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	rows := []db.GetPostVersionsRow{
		{
			ID: 12, VersionNo: 2, Status: "published", CreatedAt: createdAt,
			Message:           sql.NullString{String: "second", Valid: true},
			CreatedBy:         sql.NullInt64{Int64: 1, Valid: true},
			CreatedByUsername: sql.NullString{String: "testuser", Valid: true},
		},
		{ID: 11, VersionNo: 1, Status: "published", CreatedAt: createdAt},
	}
	published := db.Post{ID: 1, PostStatus: "published", PublishedVersionID: sql.NullInt64{Int64: 12, Valid: true}}

	runVersionsTestCases(t, []versionsTestCase{
		{
			name: "OK", role: RoleEditor, method: http.MethodGet, url: "/api/v1/posts/1/versions",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), int64(1)).Times(1).Return(published, nil)
				store.EXPECT().GetPostVersions(gomock.Any(), int64(1)).Times(1).Return(rows, nil)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp PostVersionsResponse
				require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &resp))
				require.Equal(t, "published", resp.PostStatus)
				require.NotNil(t, resp.PublishedVersionID)
				require.Equal(t, int64(12), *resp.PublishedVersionID)
				require.Len(t, resp.Versions, 2)
				require.Equal(t, int32(2), resp.Versions[0].VersionNo)
				require.True(t, resp.Versions[0].IsPublished)
				require.Equal(t, "second", *resp.Versions[0].Message)
				require.Equal(t, "testuser", *resp.Versions[0].CreatedByUsername)
				require.False(t, resp.Versions[1].IsPublished)
				require.Nil(t, resp.Versions[1].Message)
				require.Nil(t, resp.Versions[1].CreatedBy)
			},
		},
		{
			// After unpublish the history is still listed, but nothing is live
			name: "UnpublishedPostKeepsHistory", role: RoleAdmin, method: http.MethodGet, url: "/api/v1/posts/1/versions",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), int64(1)).Times(1).Return(db.Post{ID: 1, PostStatus: "draft"}, nil)
				store.EXPECT().GetPostVersions(gomock.Any(), int64(1)).Times(1).Return(rows, nil)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp PostVersionsResponse
				require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &resp))
				require.Equal(t, "draft", resp.PostStatus)
				require.Nil(t, resp.PublishedVersionID)
				require.Len(t, resp.Versions, 2)
				for _, v := range resp.Versions {
					require.False(t, v.IsPublished)
				}
			},
		},
		{
			name: "EmptyList", role: RoleEditor, method: http.MethodGet, url: "/api/v1/posts/1/versions",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), int64(1)).Times(1).Return(db.Post{ID: 1, PostStatus: "draft"}, nil)
				store.EXPECT().GetPostVersions(gomock.Any(), int64(1)).Times(1).Return(nil, nil)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				require.Contains(t, recorder.Body.String(), `"versions":[]`)
			},
		},
		{
			name: "PostNotFound", role: RoleEditor, method: http.MethodGet, url: "/api/v1/posts/9/versions",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), int64(9)).Times(1).Return(db.Post{}, sql.ErrNoRows)
				store.EXPECT().GetPostVersions(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: expectStatus(http.StatusNotFound),
		},
		{
			name: "ListError", role: RoleEditor, method: http.MethodGet, url: "/api/v1/posts/1/versions",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), int64(1)).Times(1).Return(published, nil)
				store.EXPECT().GetPostVersions(gomock.Any(), int64(1)).Times(1).Return(nil, fmt.Errorf("db down"))
			},
			checkResponse: expectStatus(http.StatusInternalServerError),
		},
		{
			name: "InvalidID", role: RoleEditor, method: http.MethodGet, url: "/api/v1/posts/abc/versions",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: expectStatus(http.StatusBadRequest),
		},
		{
			name: "ContributorForbidden", role: RoleContributor, method: http.MethodGet, url: "/api/v1/posts/1/versions",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), gomock.Any()).Times(0)
				store.EXPECT().GetPostVersions(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: expectStatus(http.StatusForbidden),
		},
		{
			name: "NoAuthorization", role: "", method: http.MethodGet, url: "/api/v1/posts/1/versions",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPostVersions(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: expectStatus(http.StatusUnauthorized),
		},
	})
}

func TestGetPostVersionAPI(t *testing.T) {
	doc := json.RawMessage(`{"doc_version":1,"blocks_order":["b1"],"blocks":{"b1":{"id":"b1","type":"paragraph","attrs":{"text":"old"}}}}`)
	row := db.GetPostVersionRow{
		ID: 11, VersionNo: 1, Status: "published", BlockDoc: doc,
		Label:     sql.NullString{String: "launch", Valid: true},
		CreatedAt: time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC),
	}

	runVersionsTestCases(t, []versionsTestCase{
		{
			name: "OK", role: RoleEditor, method: http.MethodGet, url: "/api/v1/posts/1/versions/1",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPostVersion(gomock.Any(), db.GetPostVersionParams{PostID: 1, VersionNo: 1}).
					Times(1).
					Return(row, nil)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp PostVersionResponse
				require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &resp))
				require.Equal(t, int32(1), resp.VersionNo)
				require.Equal(t, "launch", *resp.Label)
				require.Equal(t, 1, resp.Doc.DocVersion)
				require.Equal(t, []string{"b1"}, resp.Doc.BlocksOrder)
				require.Contains(t, resp.Doc.Blocks, "b1")
			},
		},
		{
			// Version numbers are scoped to the post: another post's version is a 404
			name: "NotFound", role: RoleEditor, method: http.MethodGet, url: "/api/v1/posts/2/versions/1",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPostVersion(gomock.Any(), db.GetPostVersionParams{PostID: 2, VersionNo: 1}).
					Times(1).
					Return(db.GetPostVersionRow{}, sql.ErrNoRows)
			},
			checkResponse: expectStatus(http.StatusNotFound),
		},
		{
			name: "CorruptDoc", role: RoleEditor, method: http.MethodGet, url: "/api/v1/posts/1/versions/1",
			buildStubs: func(store *mockdb.MockStore) {
				bad := row
				bad.BlockDoc = json.RawMessage(`"not a doc"`)
				store.EXPECT().GetPostVersion(gomock.Any(), gomock.Any()).Times(1).Return(bad, nil)
			},
			checkResponse: expectStatus(http.StatusInternalServerError),
		},
		{
			name: "DBError", role: RoleEditor, method: http.MethodGet, url: "/api/v1/posts/1/versions/1",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPostVersion(gomock.Any(), gomock.Any()).Times(1).Return(db.GetPostVersionRow{}, fmt.Errorf("db down"))
			},
			checkResponse: expectStatus(http.StatusInternalServerError),
		},
		{
			name: "InvalidVersionNo", role: RoleEditor, method: http.MethodGet, url: "/api/v1/posts/1/versions/0",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPostVersion(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: expectStatus(http.StatusBadRequest),
		},
		{
			name: "NonNumericVersionNo", role: RoleEditor, method: http.MethodGet, url: "/api/v1/posts/1/versions/latest",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPostVersion(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: expectStatus(http.StatusBadRequest),
		},
		{
			name: "InvalidPostID", role: RoleEditor, method: http.MethodGet, url: "/api/v1/posts/abc/versions/1",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPostVersion(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: expectStatus(http.StatusBadRequest),
		},
		{
			name: "ContributorForbidden", role: RoleContributor, method: http.MethodGet, url: "/api/v1/posts/1/versions/1",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPostVersion(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: expectStatus(http.StatusForbidden),
		},
		{
			name: "NoAuthorization", role: "", method: http.MethodGet, url: "/api/v1/posts/1/versions/1",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPostVersion(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: expectStatus(http.StatusUnauthorized),
		},
	})
}

func TestUnpublishPostAPI(t *testing.T) {
	draft := db.Post{ID: 1, Title: "Hello", PostStatus: "draft", PostType: "post"}

	runVersionsTestCases(t, []versionsTestCase{
		{
			name: "OK", role: RoleEditor, method: http.MethodPost, url: "/api/v1/posts/1/unpublish",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().UnpublishPost(gomock.Any(), int64(1)).Times(1).Return(draft, nil)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp struct {
					Post PostResponse `json:"post"`
				}
				require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &resp))
				require.Equal(t, int64(1), resp.Post.ID)
				require.Equal(t, "draft", resp.Post.PostStatus)
				require.Nil(t, resp.Post.PublishedBlocks)
			},
		},
		{
			name: "AdminAllowed", role: RoleAdmin, method: http.MethodPost, url: "/api/v1/posts/1/unpublish",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().UnpublishPost(gomock.Any(), int64(1)).Times(1).Return(draft, nil)
			},
			checkResponse: expectStatus(http.StatusOK),
		},
		{
			name: "NotFound", role: RoleEditor, method: http.MethodPost, url: "/api/v1/posts/9/unpublish",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().UnpublishPost(gomock.Any(), int64(9)).Times(1).Return(db.Post{}, sql.ErrNoRows)
			},
			checkResponse: expectStatus(http.StatusNotFound),
		},
		{
			name: "DBError", role: RoleEditor, method: http.MethodPost, url: "/api/v1/posts/1/unpublish",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().UnpublishPost(gomock.Any(), int64(1)).Times(1).Return(db.Post{}, fmt.Errorf("db down"))
			},
			checkResponse: expectStatus(http.StatusInternalServerError),
		},
		{
			name: "InvalidID", role: RoleEditor, method: http.MethodPost, url: "/api/v1/posts/abc/unpublish",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().UnpublishPost(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: expectStatus(http.StatusBadRequest),
		},
		{
			name: "ContributorForbidden", role: RoleContributor, method: http.MethodPost, url: "/api/v1/posts/1/unpublish",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().UnpublishPost(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: expectStatus(http.StatusForbidden),
		},
		{
			name: "NoAuthorization", role: "", method: http.MethodPost, url: "/api/v1/posts/1/unpublish",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().UnpublishPost(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: expectStatus(http.StatusUnauthorized),
		},
	})
}
