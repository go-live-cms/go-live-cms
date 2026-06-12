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

	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/token"
)

func randomPostMediaRow(postID int64, media db.Medium) db.GetPostMediaRow {
	return db.GetPostMediaRow{
		PostID:           postID,
		MediaID:          media.ID,
		Order:            1,
		Name:             media.Name,
		Description:      media.Description,
		Alt:              media.Alt,
		MediaPath:        media.MediaPath,
		Width:            800,
		Height:           600,
		FileSize:         media.FileSize,
		MimeType:         media.MimeType,
		OriginalFilename: media.OriginalFilename,
		UserID:           media.UserID,
		CreatedAt:        time.Now(),
		ChangedAt:        time.Now(),
	}
}

// TestCreatePostMediaAPI tests POST /posts/:id/media
func TestCreatePostMediaAPI(t *testing.T) {
	user := randomUserForPosts()
	post := randomPost(user)
	media := randomMedia()
	postMedium := db.PostMedium{PostID: post.ID, MediaID: media.ID, Order: 1}

	testCases := []struct {
		name          string
		postID        int64
		body          gin.H
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:   "OK",
			postID: post.ID,
			body:   gin.H{"media_id": media.ID, "order": 1},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					CreatePostMedia(gomock.Any(), db.CreatePostMediaParams{
						PostID:  post.ID,
						MediaID: media.ID,
						Order:   1,
					}).
					Times(1).
					Return(postMedium, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusCreated, recorder.Code)
			},
		},
		{
			name:      "NoAuthorization",
			postID:    post.ID,
			body:      gin.H{"media_id": media.ID},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().CreatePostMedia(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name:   "InvalidBody",
			postID: post.ID,
			body:   gin.H{},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().CreatePostMedia(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name:   "InvalidPostID",
			postID: 0,
			body:   gin.H{"media_id": media.ID},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().CreatePostMedia(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				// 0 is a valid int64 so the handler will attempt the DB call; override with urlOverride below
				// this case is handled via the url override variant
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name:   "InternalError",
			postID: post.ID,
			body:   gin.H{"media_id": media.ID},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					CreatePostMedia(gomock.Any(), gomock.Any()).
					Times(1).
					Return(db.PostMedium{}, sql.ErrConnDone)
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
			stubRoleLookup(store, user)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			bodyBytes, err := json.Marshal(tc.body)
			require.NoError(t, err)

			var url string
			if tc.name == "InvalidPostID" {
				url = "/api/v1/posts/abc/media"
			} else {
				url = fmt.Sprintf("/api/v1/posts/%d/media", tc.postID)
			}
			request, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(bodyBytes))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

// TestGetPostMediaAPI tests GET /posts/:id/media
func TestGetPostMediaAPI(t *testing.T) {
	user := randomUserForPosts()
	post := randomPost(user)
	media := randomMedia()
	postMediaRow := randomPostMediaRow(post.ID, media)

	testCases := []struct {
		name          string
		postID        int64
		query         string
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:   "OK",
			postID: post.ID,
			query:  "",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPostMedia(gomock.Any(), post.ID).
					Times(1).
					Return([]db.GetPostMediaRow{postMediaRow}, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp map[string]interface{}
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				require.NotNil(t, resp["data"])
			},
		},
		{
			name:   "FeaturedOnly",
			postID: post.ID,
			query:  "?featured=true",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetFeaturedImage(gomock.Any(), post.ID).
					Times(1).
					Return(randomFeaturedImageRow(post.ID, media), nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp map[string]interface{}
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				require.NotNil(t, resp["data"])
			},
		},
		{
			name:   "EmptyList",
			postID: post.ID,
			query:  "",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPostMedia(gomock.Any(), post.ID).
					Times(1).
					Return([]db.GetPostMediaRow{}, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name:   "InternalError",
			postID: post.ID,
			query:  "",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPostMedia(gomock.Any(), post.ID).
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

			url := fmt.Sprintf("/api/v1/posts/%d/media%s", tc.postID, tc.query)
			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

// TestDeletePostMediaAPI tests DELETE /posts/:id/media/:media_id
func TestDeletePostMediaAPI(t *testing.T) {
	user := randomUserForPosts()
	post := randomPost(user)
	media := randomMedia()

	testCases := []struct {
		name          string
		postID        int64
		mediaID       int64
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:    "OK",
			postID:  post.ID,
			mediaID: media.ID,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					DeletePostMedia(gomock.Any(), db.DeletePostMediaParams{
						PostID:  post.ID,
						MediaID: media.ID,
					}).
					Times(1).
					Return(nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp map[string]interface{}
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				require.Equal(t, "post media association deleted", resp["message"])
			},
		},
		{
			name:      "NoAuthorization",
			postID:    post.ID,
			mediaID:   media.ID,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().DeletePostMedia(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name:    "InternalError",
			postID:  post.ID,
			mediaID: media.ID,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					DeletePostMedia(gomock.Any(), gomock.Any()).
					Times(1).
					Return(sql.ErrConnDone)
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
			stubRoleLookup(store, user)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			url := fmt.Sprintf("/api/v1/posts/%d/media/%d", tc.postID, tc.mediaID)
			request, err := http.NewRequest(http.MethodDelete, url, nil)
			require.NoError(t, err)

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}
