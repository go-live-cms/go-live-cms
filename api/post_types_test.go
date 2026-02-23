package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
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

func randomPostType(name string) db.PostType {
	return db.PostType{
		ID:           1,
		Name:         name,
		Label:        name[:1] + name[1:] + "s",
		Description:  sql.NullString{String: "Test " + name, Valid: true},
		Public:       true,
		Hierarchical: false,
		HasArchive:   true,
		MenuPosition: sql.NullInt32{Int32: 5, Valid: true},
		Supports:     json.RawMessage(`["title","content","description"]`),
		IsActive:     true,
		RegisteredBy: "user",
		CreatedAt:    time.Now(),
	}
}

func TestGetPostTypesAPI(t *testing.T) {
	postType1 := randomPostType("post")
	postType1.RegisteredBy = "system"
	postType2 := randomPostType("product")
	postType2.ID = 2
	postType2.RegisteredBy = "theme:example"

	testCases := []struct {
		name          string
		query         string
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:  "OK_ActiveOnly",
			query: "",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					ListActivePostTypes(gomock.Any()).
					Times(1).
					Return([]db.PostType{postType1, postType2}, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)

				var response map[string][]PostTypeResponse
				err := json.Unmarshal(recorder.Body.Bytes(), &response)
				require.NoError(t, err)
				require.Len(t, response["post_types"], 2)
				require.Equal(t, "post", response["post_types"][0].Name)
				require.Equal(t, "product", response["post_types"][1].Name)
			},
		},
		{
			name:  "OK_AllTypes",
			query: "?all=true",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					ListPostTypes(gomock.Any()).
					Times(1).
					Return([]db.PostType{postType1, postType2}, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name:  "InternalError",
			query: "",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					ListActivePostTypes(gomock.Any()).
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

			url := "/api/v1/post-types" + tc.query
			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestCreatePostTypeAPI(t *testing.T) {
	user := randomUserForPosts()
	product := randomPostType("product")
	product.RegisteredBy = "user"

	testCases := []struct {
		name          string
		body          gin.H
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name: "OK",
			body: gin.H{
				"name":  "product",
				"label": "Products",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					UpsertPostType(gomock.Any(), gomock.Any()).
					Times(1).
					Return(product, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusCreated, recorder.Code)

				var response map[string]PostTypeResponse
				err := json.Unmarshal(recorder.Body.Bytes(), &response)
				require.NoError(t, err)
				require.Equal(t, "product", response["post_type"].Name)
				require.True(t, response["post_type"].IsActive)
			},
		},
		{
			name: "SystemTypeBlocked",
			body: gin.H{
				"name":  "post",
				"label": "Blog Posts",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusConflict, recorder.Code)
			},
		},
		{
			name: "SystemPageBlocked",
			body: gin.H{
				"name":  "page",
				"label": "Pages Override",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusConflict, recorder.Code)
			},
		},
		{
			name: "NoAuth",
			body: gin.H{
				"name":  "product",
				"label": "Products",
			},
			setupAuth:  func(t *testing.T, request *http.Request, tokenMaker token.Maker) {},
			buildStubs: func(store *mockdb.MockStore) {},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name: "SlugAlias",
			body: gin.H{
				"name":  "",
				"slug":  "portfolio",
				"label": "Portfolio",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					UpsertPostType(gomock.Any(), gomock.Any()).
					Times(1).
					DoAndReturn(func(ctx interface{}, arg db.UpsertPostTypeParams) (db.PostType, error) {
						require.Equal(t, "portfolio", arg.Name)
						return db.PostType{
							ID:           3,
							Name:         "portfolio",
							Label:        "Portfolio",
							IsActive:     true,
							RegisteredBy: "user",
							Supports:     json.RawMessage(`["title","content","description"]`),
							CreatedAt:    time.Now(),
						}, nil
					})
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusCreated, recorder.Code)
			},
		},
		{
			name: "InvalidBody",
			body: gin.H{},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
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

			body, err := json.Marshal(tc.body)
			require.NoError(t, err)

			request, err := http.NewRequest(http.MethodPost, "/api/v1/post-types", bytes.NewReader(body))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestUpdatePostTypeAPI(t *testing.T) {
	user := randomUserForPosts()
	existing := randomPostType("product")

	testCases := []struct {
		name          string
		typeName      string
		body          gin.H
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:     "OK",
			typeName: "product",
			body: gin.H{
				"label": "Updated Products",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPostType(gomock.Any(), gomock.Eq("product")).
					Times(1).
					Return(existing, nil)
				store.EXPECT().
					UpdatePostType(gomock.Any(), gomock.Any()).
					Times(1).
					Return(existing, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name:     "SystemTypeBlocked",
			typeName: "post",
			body: gin.H{
				"label": "Modified Posts",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusConflict, recorder.Code)
			},
		},
		{
			name:     "NotFound",
			typeName: "nonexistent",
			body: gin.H{
				"label": "Something",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPostType(gomock.Any(), gomock.Eq("nonexistent")).
					Times(1).
					Return(db.PostType{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:     "NoAuth",
			typeName: "product",
			body: gin.H{
				"label": "Products",
			},
			setupAuth:  func(t *testing.T, request *http.Request, tokenMaker token.Maker) {},
			buildStubs: func(store *mockdb.MockStore) {},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
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

			body, err := json.Marshal(tc.body)
			require.NoError(t, err)

			url := "/api/v1/post-types/" + tc.typeName
			request, err := http.NewRequest(http.MethodPut, url, bytes.NewReader(body))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestGetPostTypesFiltersInactiveByDefault(t *testing.T) {
	// Verifies that the default endpoint returns only active post types
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	activeType := randomPostType("product")
	activeType.IsActive = true

	store := mockdb.NewMockStore(ctrl)
	store.EXPECT().
		ListActivePostTypes(gomock.Any()).
		Times(1).
		Return([]db.PostType{activeType}, nil)

	server := newTestServer(t, store)
	recorder := httptest.NewRecorder()

	request, err := http.NewRequest(http.MethodGet, "/api/v1/post-types", nil)
	require.NoError(t, err)

	server.router.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusOK, recorder.Code)

	var response map[string][]PostTypeResponse
	err = json.Unmarshal(recorder.Body.Bytes(), &response)
	require.NoError(t, err)
	require.Len(t, response["post_types"], 1)
	require.Equal(t, "product", response["post_types"][0].Name)
	require.True(t, response["post_types"][0].IsActive)
}
