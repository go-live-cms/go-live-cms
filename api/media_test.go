package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/brianvoe/gofakeit/v6"
	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/token"
)

func randomMedia() db.Medium {
	gofakeit.Seed(0)
	return db.Medium{
		ID:          gofakeit.Int64(),
		Name:        gofakeit.Word(),
		Description: gofakeit.Sentence(10),
		Alt:         gofakeit.Sentence(5),
		MediaPath:   fmt.Sprintf("/uploads/media/%s.jpg", gofakeit.UUID()),
		UserID:      gofakeit.Int64(),
		CreatedAt:   time.Now(),
		ChangedAt:   time.Now(),
	}
}

func TestCreateMediaAPI(t *testing.T) {
	user := randomUserForPosts()
	media := randomMedia()

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
				"name":        media.Name,
				"description": media.Description,
				"alt":         media.Alt,
				"media_path":  media.MediaPath,
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					CreateMedia(gomock.Any(), gomock.Any()).
					Times(1).
					Return(media, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusCreated, recorder.Code)
				requireBodyMatchMedia(t, recorder.Body.String(), media)
			},
		},
		{
			name: "WithPostLink",
			body: gin.H{
				"name":        media.Name,
				"description": media.Description,
				"alt":         media.Alt,
				"media_path":  media.MediaPath,
				"post_id":     int64(1),
				"order":       int32(0),
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					CreateMediaAndLinkTx(gomock.Any(), gomock.Any()).
					Times(1).
					Return(db.CreateMediaAndLinkTxResult{
						Media: media,
						PostMedia: db.PostMedium{
							PostID:  1,
							MediaID: media.ID,
							Order:   0,
						},
					}, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusCreated, recorder.Code)
				requireBodyMatchMedia(t, recorder.Body.String(), media)
			},
		},
		{
			name: "NoAuthorization",
			body: gin.H{
				"name":        media.Name,
				"description": media.Description,
				"alt":         media.Alt,
				"media_path":  media.MediaPath,
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					CreateMedia(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name: "InvalidName",
			body: gin.H{
				"name":        "A",
				"description": media.Description,
				"alt":         media.Alt,
				"media_path":  media.MediaPath,
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					CreateMedia(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name: "InvalidDescription",
			body: gin.H{
				"name":        media.Name,
				"description": "Bad",
				"alt":         media.Alt,
				"media_path":  media.MediaPath,
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					CreateMedia(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name: "PostNotFound",
			body: gin.H{
				"name":        media.Name,
				"description": media.Description,
				"alt":         media.Alt,
				"media_path":  media.MediaPath,
				"post_id":     int64(999),
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					CreateMediaAndLinkTx(gomock.Any(), gomock.Any()).
					Times(1).
					Return(db.CreateMediaAndLinkTxResult{}, fmt.Errorf("post not found"))
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

			var buf bytes.Buffer
			writer := multipart.NewWriter(&buf)

			for key, value := range tc.body {
				if key != "media_path" {
					err := writer.WriteField(key, fmt.Sprintf("%v", value))
					require.NoError(t, err)
				}
			}

			part, err := writer.CreateFormFile("file", "test.jpg")
			require.NoError(t, err)
			_, err = part.Write([]byte("fake image content"))
			require.NoError(t, err)

			err = writer.Close()
			require.NoError(t, err)

			url := "/api/v1/media"
			request, err := http.NewRequest(http.MethodPost, url, &buf)
			require.NoError(t, err)
			request.Header.Set("Content-Type", writer.FormDataContentType())

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestGetMediaAPI(t *testing.T) {
	media := randomMedia()

	testCases := []struct {
		name          string
		mediaID       int64
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:    "OK",
			mediaID: media.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetMedia(gomock.Any(), gomock.Eq(media.ID)).
					Times(1).
					Return(media, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				requireBodyMatchMedia(t, recorder.Body.String(), media)
			},
		},
		{
			name:    "NotFound",
			mediaID: media.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetMedia(gomock.Any(), gomock.Eq(media.ID)).
					Times(1).
					Return(db.Medium{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:    "InternalError",
			mediaID: media.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetMedia(gomock.Any(), gomock.Eq(media.ID)).
					Times(1).
					Return(db.Medium{}, sql.ErrConnDone)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
		{
			name:    "InvalidID",
			mediaID: 0,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetMedia(gomock.Any(), gomock.Any()).
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

			var url string
			if tc.name == "InvalidID" {
				url = "/api/v1/media/invalid_id"
			} else {
				url = fmt.Sprintf("/api/v1/media/%d", tc.mediaID)
			}

			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestListMediaAPI(t *testing.T) {
	n := 5
	media := make([]db.Medium, n)
	for i := 0; i < n; i++ {
		media[i] = randomMedia()
		media[i].ID = int64(i + 1)
	}

	mediaWithCount := make([]db.ListMediaWithPostCountRow, n)
	for i := 0; i < n; i++ {
		mediaWithCount[i] = db.ListMediaWithPostCountRow{
			ID:          media[i].ID,
			Name:        media[i].Name,
			Description: media[i].Description,
			Alt:         media[i].Alt,
			MediaPath:   media[i].MediaPath,
			UserID:      media[i].UserID,
			CreatedAt:   media[i].CreatedAt,
			ChangedAt:   media[i].ChangedAt,
			PostCount:   int64(i),
		}
	}

	testCases := []struct {
		name          string
		query         string
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:  "OK",
			query: "?limit=5&offset=0",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					ListMedia(gomock.Any(), db.ListMediaParams{
						Limit:  5,
						Offset: 0,
					}).
					Times(1).
					Return(media, nil)
				store.EXPECT().
					CountTotalMedia(gomock.Any()).
					Times(1).
					Return(int64(100), nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				requireBodyMatchMediaList(t, recorder.Body.String(), media, int64(100))
			},
		},
		{
			name:  "WithCounts",
			query: "?limit=5&offset=0&with_counts=true",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					ListMediaWithPostCount(gomock.Any(), db.ListMediaWithPostCountParams{
						Limit:  5,
						Offset: 0,
					}).
					Times(1).
					Return(mediaWithCount, nil)
				store.EXPECT().
					CountTotalMedia(gomock.Any()).
					Times(1).
					Return(int64(150), nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				requireBodyMatchMediaWithCount(t, recorder.Body.String(), mediaWithCount, int64(150))
			},
		},
		{
			name:  "InternalError",
			query: "?limit=5&offset=0",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					ListMedia(gomock.Any(), gomock.Any()).
					Times(1).
					Return([]db.Medium{}, sql.ErrConnDone)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
		{
			name:  "InvalidLimit",
			query: "?limit=0",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					ListMedia(gomock.Any(), gomock.Any()).
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

			url := "/api/v1/media" + tc.query
			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestGetPopularMediaAPI(t *testing.T) {
	n := 3
	popularMedia := make([]db.GetPopularMediaRow, n)
	for i := 0; i < n; i++ {
		media := randomMedia()
		popularMedia[i] = db.GetPopularMediaRow{
			ID:          media.ID,
			Name:        media.Name,
			Description: media.Description,
			Alt:         media.Alt,
			MediaPath:   media.MediaPath,
			UserID:      media.UserID,
			CreatedAt:   media.CreatedAt,
			ChangedAt:   media.ChangedAt,
			PostCount:   int64(10 - i),
		}
	}

	testCases := []struct {
		name          string
		query         string
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:  "OK",
			query: "?limit=10",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPopularMedia(gomock.Any(), int32(10)).
					Times(1).
					Return(popularMedia, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				requireBodyMatchPopularMedia(t, recorder.Body.String(), popularMedia)
			},
		},
		{
			name:  "InternalError",
			query: "?limit=10",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPopularMedia(gomock.Any(), gomock.Any()).
					Times(1).
					Return([]db.GetPopularMediaRow{}, sql.ErrConnDone)
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

			url := "/api/v1/media/popular" + tc.query
			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestSearchMediaAPI(t *testing.T) {
	media := randomMedia()
	searchResults := []db.Medium{media}

	testCases := []struct {
		name          string
		query         string
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:  "OK",
			query: "?q=test&limit=10&offset=0",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					SearchMediaByName(gomock.Any(), db.SearchMediaByNameParams{
						Column1: sql.NullString{String: "test", Valid: true},
						Limit:   10,
						Offset:  0,
					}).
					Times(1).
					Return(searchResults, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				requireBodyMatchMediaListWithoutTotal(t, recorder.Body.String(), searchResults)
			},
		},
		{
			name:  "EmptyQuery",
			query: "?q=&limit=10",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					SearchMediaByName(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name:  "MissingQuery",
			query: "?limit=10",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					SearchMediaByName(gomock.Any(), gomock.Any()).
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

			url := "/api/v1/media/search" + tc.query
			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestUpdateMediaAPI(t *testing.T) {
	user := randomUserForPosts()
	media := randomMedia()
	newName := gofakeit.Word()
	newDescription := gofakeit.Sentence(10)

	testCases := []struct {
		name          string
		mediaID       int64
		body          gin.H
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:    "OK",
			mediaID: media.ID,
			body: gin.H{
				"name":        newName,
				"description": newDescription,
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {

				store.EXPECT().
					GetMedia(gomock.Any(), gomock.Eq(media.ID)).
					Times(1).
					Return(media, nil)

				updatedMedia := media
				updatedMedia.Name = newName
				updatedMedia.Description = newDescription

				store.EXPECT().
					UpdateMedia(gomock.Any(), gomock.Any()).
					Times(1).
					Return(updatedMedia, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name:    "NoAuthorization",
			mediaID: media.ID,
			body: gin.H{
				"name":        newName,
				"description": newDescription,
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetMedia(gomock.Any(), gomock.Any()).
					Times(0)
				store.EXPECT().
					UpdateMedia(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name:    "NotFound",
			mediaID: media.ID,
			body: gin.H{
				"name": newName,
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetMedia(gomock.Any(), gomock.Eq(media.ID)).
					Times(1).
					Return(db.Medium{}, sql.ErrNoRows)
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

			data, err := json.Marshal(tc.body)
			require.NoError(t, err)

			url := fmt.Sprintf("/api/v1/media/%d", tc.mediaID)
			request, err := http.NewRequest(http.MethodPut, url, bytes.NewReader(data))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestDeleteMediaAPI(t *testing.T) {
	user := randomUserForPosts()
	media := randomMedia()

	testCases := []struct {
		name          string
		mediaID       int64
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:    "OK",
			mediaID: media.ID,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetMedia(gomock.Any(), gomock.Eq(media.ID)).
					Times(1).
					Return(media, nil)

				store.EXPECT().
					DeleteMediaTx(gomock.Any(), gomock.Any()).
					Times(1).
					Return(nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name:    "NoAuthorization",
			mediaID: media.ID,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetMedia(gomock.Any(), gomock.Any()).
					Times(0)
				store.EXPECT().
					DeleteMediaTx(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name:    "NotFound",
			mediaID: media.ID,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetMedia(gomock.Any(), gomock.Eq(media.ID)).
					Times(1).
					Return(db.Medium{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:    "PermissionDenied",
			mediaID: media.ID,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetMedia(gomock.Any(), gomock.Eq(media.ID)).
					Times(1).
					Return(media, nil)

				store.EXPECT().
					DeleteMediaTx(gomock.Any(), gomock.Any()).
					Times(1).
					Return(fmt.Errorf("permission denied: user does not own this media"))
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusForbidden, recorder.Code)
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

			url := fmt.Sprintf("/api/v1/media/%d", tc.mediaID)
			request, err := http.NewRequest(http.MethodDelete, url, nil)
			require.NoError(t, err)

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestGetMediaByUserAPI(t *testing.T) {
	user := randomUserForPosts()
	media := randomMedia()
	media.UserID = user.ID
	userMedia := []db.Medium{media}

	testCases := []struct {
		name          string
		userID        int64
		query         string
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:   "OK",
			userID: user.ID,
			query:  "?limit=10&offset=0",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(user.ID)).
					Times(1).
					Return(user, nil)

				store.EXPECT().
					GetMediaByUser(gomock.Any(), db.GetMediaByUserParams{
						UserID: user.ID,
						Limit:  10,
						Offset: 0,
					}).
					Times(1).
					Return(userMedia, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				requireBodyMatchMediaListWithoutTotal(t, recorder.Body.String(), userMedia)
			},
		},
		{
			name:   "UserNotFound",
			userID: user.ID,
			query:  "?limit=10&offset=0",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(user.ID)).
					Times(1).
					Return(db.User{}, sql.ErrNoRows)
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

			url := fmt.Sprintf("/api/v1/media/user/%d%s", tc.userID, tc.query)
			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestGetMediaByPostAPI(t *testing.T) {
	user := randomUserForPosts()
	post := randomPost(user)
	media := randomMedia()
	postMedia := []db.Medium{media}

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
					GetPost(gomock.Any(), gomock.Eq(post.ID)).
					Times(1).
					Return(post, nil)

				store.EXPECT().
					GetMediaByPost(gomock.Any(), gomock.Eq(post.ID)).
					Times(1).
					Return(postMedia, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				requireBodyMatchMediaByPost(t, recorder.Body.String(), post, postMedia)
			},
		},
		{
			name:   "PostNotFound",
			postID: post.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), gomock.Eq(post.ID)).
					Times(1).
					Return(db.Post{}, sql.ErrNoRows)
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

			url := fmt.Sprintf("/api/v1/media/post/%d", tc.postID)
			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func requireBodyMatchMedia(t *testing.T, body string, media db.Medium) {
	var response struct {
		Media MediaResponse `json:"media"`
	}
	err := json.Unmarshal([]byte(body), &response)
	require.NoError(t, err)

	require.Equal(t, media.ID, response.Media.ID)
	require.Equal(t, media.Name, response.Media.Name)
	require.Equal(t, media.Description, response.Media.Description)
	require.Equal(t, media.Alt, response.Media.Alt)
	require.Equal(t, media.MediaPath, response.Media.MediaPath)
	require.Equal(t, media.UserID, response.Media.UserID)
}

func requireBodyMatchMediaList(t *testing.T, body string, media []db.Medium, expectedTotal int64) {
	var response struct {
		Media []MediaResponse `json:"media"`
		Meta  struct {
			Limit      int   `json:"limit"`
			Offset     int   `json:"offset"`
			Count      int   `json:"count"`
			WithCounts bool  `json:"with_counts"`
			Total      int64 `json:"total"`
		} `json:"meta"`
	}
	err := json.Unmarshal([]byte(body), &response)
	require.NoError(t, err)

	require.Equal(t, len(media), len(response.Media))
	require.Equal(t, expectedTotal, response.Meta.Total)
	for i, m := range media {
		require.Equal(t, m.ID, response.Media[i].ID)
		require.Equal(t, m.Name, response.Media[i].Name)
		require.Equal(t, m.Description, response.Media[i].Description)
		require.Equal(t, m.Alt, response.Media[i].Alt)
		require.Equal(t, m.MediaPath, response.Media[i].MediaPath)
		require.Equal(t, m.UserID, response.Media[i].UserID)
	}
}

func requireBodyMatchMediaWithCount(t *testing.T, body string, media []db.ListMediaWithPostCountRow, expectedTotal int64) {
	var response struct {
		Media []MediaResponse `json:"media"`
		Meta  struct {
			Total      int64 `json:"total"`
			Limit      int   `json:"limit"`
			Offset     int   `json:"offset"`
			Count      int   `json:"count"`
			WithCounts bool  `json:"with_counts"`
		} `json:"meta"`
	}
	err := json.Unmarshal([]byte(body), &response)
	require.NoError(t, err)

	require.Equal(t, len(media), len(response.Media))
	require.True(t, response.Meta.WithCounts)
	require.Equal(t, expectedTotal, response.Meta.Total)
	for i, m := range media {
		require.Equal(t, m.ID, response.Media[i].ID)
		require.Equal(t, m.Name, response.Media[i].Name)
		require.Equal(t, m.Description, response.Media[i].Description)
		require.Equal(t, m.Alt, response.Media[i].Alt)
		require.Equal(t, m.MediaPath, response.Media[i].MediaPath)
		require.Equal(t, m.UserID, response.Media[i].UserID)
		require.NotNil(t, response.Media[i].PostCount)
		require.Equal(t, m.PostCount, *response.Media[i].PostCount)
	}
}

func requireBodyMatchMediaListWithoutTotal(t *testing.T, body string, media []db.Medium) {
	var response struct {
		Media []MediaResponse `json:"media"`
		Meta  struct {
			Query  string `json:"query,omitempty"`
			UserID int64  `json:"user_id,omitempty"`
			Limit  int    `json:"limit"`
			Offset int    `json:"offset"`
			Count  int    `json:"count"`
		} `json:"meta"`
	}
	err := json.Unmarshal([]byte(body), &response)
	require.NoError(t, err)

	require.Equal(t, len(media), len(response.Media))
	for i, m := range media {
		require.Equal(t, m.ID, response.Media[i].ID)
		require.Equal(t, m.Name, response.Media[i].Name)
		require.Equal(t, m.Description, response.Media[i].Description)
		require.Equal(t, m.Alt, response.Media[i].Alt)
		require.Equal(t, m.MediaPath, response.Media[i].MediaPath)
		require.Equal(t, m.UserID, response.Media[i].UserID)
	}
}

func requireBodyMatchPopularMedia(t *testing.T, body string, media []db.GetPopularMediaRow) {
	var response struct {
		Media []PopularMediaResponse `json:"media"`
		Meta  struct {
			Limit int `json:"limit"`
			Count int `json:"count"`
		} `json:"meta"`
	}
	err := json.Unmarshal([]byte(body), &response)
	require.NoError(t, err)

	require.Equal(t, len(media), len(response.Media))
	for i, m := range media {
		require.Equal(t, m.ID, response.Media[i].ID)
		require.Equal(t, m.Name, response.Media[i].Name)
		require.Equal(t, m.Description, response.Media[i].Description)
		require.Equal(t, m.Alt, response.Media[i].Alt)
		require.Equal(t, m.MediaPath, response.Media[i].MediaPath)
		require.Equal(t, m.UserID, response.Media[i].UserID)
		require.Equal(t, m.PostCount, response.Media[i].PostCount)
	}
}

func requireBodyMatchMediaByPost(t *testing.T, body string, post db.Post, media []db.Medium) {
	var response struct {
		Post  PostResponse    `json:"post"`
		Media []MediaResponse `json:"media"`
		Meta  struct {
			PostID int `json:"post_id"`
			Count  int `json:"count"`
		} `json:"meta"`
	}
	err := json.Unmarshal([]byte(body), &response)
	require.NoError(t, err)

	require.Equal(t, post.ID, response.Post.ID)
	require.Equal(t, post.Title, response.Post.Title)
	require.Equal(t, len(media), len(response.Media))
	require.Equal(t, int(post.ID), response.Meta.PostID)
}
