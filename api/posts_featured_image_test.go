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

func randomFeaturedImageRow(postID int64, media db.Medium) db.GetFeaturedImageRow {
	return db.GetFeaturedImageRow{
		PostID:           postID,
		MediaID:          media.ID,
		Order:            0,
		Name:             media.Name,
		Description:      media.Description,
		Alt:              media.Alt,
		MediaPath:        media.MediaPath,
		Width:            800,
		Height:           600,
		FileSize:         media.FileSize,
		MimeType:         media.MimeType,
		OriginalFilename: media.OriginalFilename,
		CreatedAt:        time.Now(),
		ChangedAt:        time.Now(),
	}
}

// TestGetFeaturedImageQuickAPI tests GET /posts/:id/featured-image
func TestGetFeaturedImageQuickAPI(t *testing.T) {
	post := randomPost(randomUserForPosts())
	thumbnailMeta := db.PostMetum{
		PostID:    post.ID,
		MetaKey:   "_thumbnail_url",
		MetaValue: sql.NullString{String: "/uploads/media/thumb.jpg", Valid: true},
	}

	testCases := []struct {
		name          string
		postID        int64
		urlOverride   string
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:   "OK",
			postID: post.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPostMetaByKey(gomock.Any(), db.GetPostMetaByKeyParams{
						PostID:  post.ID,
						MetaKey: "_thumbnail_url",
					}).
					Times(1).
					Return(thumbnailMeta, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp map[string]interface{}
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				fi := resp["featured_image"].(map[string]interface{})
				require.Equal(t, thumbnailMeta.MetaValue.String, fi["url"])
			},
		},
		{
			name:   "NotSet",
			postID: post.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPostMetaByKey(gomock.Any(), gomock.Any()).
					Times(1).
					Return(db.PostMetum{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp map[string]interface{}
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				require.Nil(t, resp["featured_image"])
			},
		},
		{
			name:        "InvalidID",
			urlOverride: "/api/v1/posts/abc/featured-image",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPostMetaByKey(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name:   "InternalError",
			postID: post.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPostMetaByKey(gomock.Any(), gomock.Any()).
					Times(1).
					Return(db.PostMetum{}, sql.ErrConnDone)
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

			url := tc.urlOverride
			if url == "" {
				url = fmt.Sprintf("/api/v1/posts/%d/featured-image", tc.postID)
			}
			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

// TestGetFeaturedImageFullAPI tests GET /posts/:id/featured-image/full
func TestGetFeaturedImageFullAPI(t *testing.T) {
	post := randomPost(randomUserForPosts())
	media := randomMedia()
	featuredImageRow := randomFeaturedImageRow(post.ID, media)

	testCases := []struct {
		name          string
		postID        int64
		urlOverride   string
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:   "OK",
			postID: post.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetFeaturedImage(gomock.Any(), post.ID).
					Times(1).
					Return(featuredImageRow, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp map[string]interface{}
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				fi := resp["featured_image"].(map[string]interface{})
				require.Equal(t, featuredImageRow.MediaPath, fi["media_path"])
				require.Equal(t, featuredImageRow.Name, fi["name"])
			},
		},
		{
			name:   "NotSet",
			postID: post.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetFeaturedImage(gomock.Any(), gomock.Any()).
					Times(1).
					Return(db.GetFeaturedImageRow{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp map[string]interface{}
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				require.Nil(t, resp["featured_image"])
			},
		},
		{
			name:        "InvalidID",
			urlOverride: "/api/v1/posts/abc/featured-image/full",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetFeaturedImage(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name:   "InternalError",
			postID: post.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetFeaturedImage(gomock.Any(), gomock.Any()).
					Times(1).
					Return(db.GetFeaturedImageRow{}, sql.ErrConnDone)
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

			url := tc.urlOverride
			if url == "" {
				url = fmt.Sprintf("/api/v1/posts/%d/featured-image/full", tc.postID)
			}
			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

// TestSetFeaturedImageAPI tests POST /posts/:id/featured-image
func TestSetFeaturedImageAPI(t *testing.T) {
	user := randomUserForPosts()
	post := randomPost(user)
	media := randomMedia()

	reqBody := gin.H{
		"media_id": media.ID,
	}

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
			body:   reqBody,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), post.ID).
					Times(1).
					Return(post, nil)
				store.EXPECT().
					GetMedia(gomock.Any(), media.ID).
					Times(1).
					Return(media, nil)
				store.EXPECT().
					ExecTx(gomock.Any(), gomock.Any()).
					Times(1).
					Return(nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp map[string]interface{}
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				require.Equal(t, "featured image set successfully", resp["message"])
			},
		},
		{
			name:   "NoAuthorization",
			postID: post.ID,
			body:   reqBody,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				// no auth header
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), gomock.Any()).Times(0)
				store.EXPECT().GetMedia(gomock.Any(), gomock.Any()).Times(0)
				store.EXPECT().ExecTx(gomock.Any(), gomock.Any()).Times(0)
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
				store.EXPECT().GetPost(gomock.Any(), gomock.Any()).Times(0)
				store.EXPECT().GetMedia(gomock.Any(), gomock.Any()).Times(0)
				store.EXPECT().ExecTx(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name:   "PostNotFound",
			postID: post.ID,
			body:   reqBody,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), post.ID).
					Times(1).
					Return(db.Post{}, sql.ErrNoRows)
				store.EXPECT().GetMedia(gomock.Any(), gomock.Any()).Times(0)
				store.EXPECT().ExecTx(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:   "MediaNotFound",
			postID: post.ID,
			body:   reqBody,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), post.ID).
					Times(1).
					Return(post, nil)
				store.EXPECT().
					GetMedia(gomock.Any(), media.ID).
					Times(1).
					Return(db.Medium{}, sql.ErrNoRows)
				store.EXPECT().ExecTx(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:   "TxError",
			postID: post.ID,
			body:   reqBody,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), post.ID).
					Times(1).
					Return(post, nil)
				store.EXPECT().
					GetMedia(gomock.Any(), media.ID).
					Times(1).
					Return(media, nil)
				store.EXPECT().
					ExecTx(gomock.Any(), gomock.Any()).
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

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			bodyBytes, err := json.Marshal(tc.body)
			require.NoError(t, err)

			url := fmt.Sprintf("/api/v1/posts/%d/featured-image", tc.postID)
			request, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(bodyBytes))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

// TestRemoveFeaturedImageAPI tests DELETE /posts/:id/featured-image
func TestRemoveFeaturedImageAPI(t *testing.T) {
	user := randomUserForPosts()
	post := randomPost(user)

	testCases := []struct {
		name          string
		postID        int64
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:   "OK",
			postID: post.ID,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), post.ID).
					Times(1).
					Return(post, nil)
				store.EXPECT().
					ExecTx(gomock.Any(), gomock.Any()).
					Times(1).
					Return(nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp map[string]interface{}
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				require.Equal(t, "featured image removed successfully", resp["message"])
			},
		},
		{
			name:   "NoAuthorization",
			postID: post.ID,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				// no auth header
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), gomock.Any()).Times(0)
				store.EXPECT().ExecTx(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name:   "PostNotFound",
			postID: post.ID,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), post.ID).
					Times(1).
					Return(db.Post{}, sql.ErrNoRows)
				store.EXPECT().ExecTx(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:   "TxError",
			postID: post.ID,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), post.ID).
					Times(1).
					Return(post, nil)
				store.EXPECT().
					ExecTx(gomock.Any(), gomock.Any()).
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

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			url := fmt.Sprintf("/api/v1/posts/%d/featured-image", tc.postID)
			request, err := http.NewRequest(http.MethodDelete, url, nil)
			require.NoError(t, err)

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}
