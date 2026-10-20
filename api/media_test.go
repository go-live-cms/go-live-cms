package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
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
		Name:        gofakeit.BeerName(),
		Description: gofakeit.Sentence(10),
		Alt:         gofakeit.JobTitle(),
		MediaPath:   fmt.Sprintf("/uploads/media/%s.jpg", gofakeit.UUID()),
		UserID:      gofakeit.Int64(),
		CreatedAt:   time.Now(),
		ChangedAt:   time.Now(),
	}
}

func createMultipartRequest(fields map[string]string, filename string, fileContent string) (*http.Request, string, error) {
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)

	for field, value := range fields {
		err := writer.WriteField(field, value)
		if err != nil {
			return nil, "", err
		}
	}

	if filename != "" {
		part, err := writer.CreateFormFile("file", filename)
		if err != nil {
			return nil, "", err
		}
		_, err = io.Copy(part, strings.NewReader(fileContent))
		if err != nil {
			return nil, "", err
		}
	}

	contentType := writer.FormDataContentType()
	err := writer.Close()
	if err != nil {
		return nil, "", err
	}

	req, err := http.NewRequest(http.MethodPost, "/api/v1/media", body)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Content-Type", contentType)

	return req, contentType, nil
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
			stubRoleLookup(store, user)

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

func listMediaRowToMedium(row db.ListMediaRow) db.Medium {
	return db.Medium{
		ID:               row.ID,
		Name:             row.Name,
		Description:      row.Description,
		Alt:              row.Alt,
		MediaPath:        row.MediaPath,
		UserID:           row.UserID,
		CreatedAt:        row.CreatedAt,
		ChangedAt:        row.ChangedAt,
		FileSize:         row.FileSize,
		MimeType:         row.MimeType,
		Width:            row.Width,
		Height:           row.Height,
		Duration:         row.Duration,
		OriginalFilename: row.OriginalFilename,
		Metadata:         row.Metadata,
	}
}

func searchMediaByNameRowToMedium(row db.SearchMediaByNameRow) db.Medium {
	return db.Medium{
		ID:               row.ID,
		Name:             row.Name,
		Description:      row.Description,
		Alt:              row.Alt,
		MediaPath:        row.MediaPath,
		UserID:           row.UserID,
		CreatedAt:        row.CreatedAt,
		ChangedAt:        row.ChangedAt,
		FileSize:         row.FileSize,
		MimeType:         row.MimeType,
		Width:            row.Width,
		Height:           row.Height,
		Duration:         row.Duration,
		OriginalFilename: row.OriginalFilename,
		Metadata:         row.Metadata,
	}
}

func getMediaByUserRowToMedium(row db.GetMediaByUserRow) db.Medium {
	return db.Medium{
		ID:               row.ID,
		Name:             row.Name,
		Description:      row.Description,
		Alt:              row.Alt,
		MediaPath:        row.MediaPath,
		UserID:           row.UserID,
		CreatedAt:        row.CreatedAt,
		ChangedAt:        row.ChangedAt,
		FileSize:         row.FileSize,
		MimeType:         row.MimeType,
		Width:            row.Width,
		Height:           row.Height,
		Duration:         row.Duration,
		OriginalFilename: row.OriginalFilename,
		Metadata:         row.Metadata,
	}
}

func TestListMediaAPI(t *testing.T) {
	n := 5
	mediaWithCount := make([]db.ListMediaRow, n)
	for i := 0; i < n; i++ {
		media := randomMedia()
		media.ID = int64(i + 1)
		mediaWithCount[i] = db.ListMediaRow{
			ID:          media.ID,
			Name:        media.Name,
			Description: media.Description,
			Alt:         media.Alt,
			MediaPath:   media.MediaPath,
			UserID:      media.UserID,
			CreatedAt:   media.CreatedAt,
			ChangedAt:   media.ChangedAt,
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
						Column1: "",
						Column2: int64(0),
						Column3: "",
						Column4: "date_desc",
						Limit:   5,
						Offset:  0,
					}).
					Times(1).
					Return(mediaWithCount, nil)
				store.EXPECT().
					CountTotalMedia(gomock.Any()).
					Times(1).
					Return(int64(100), nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)

				convertedMedia := make([]db.Medium, len(mediaWithCount))
				for i, row := range mediaWithCount {
					convertedMedia[i] = listMediaRowToMedium(row)
				}
				requireBodyMatchMediaList(t, recorder.Body.String(), convertedMedia, int64(100))
			},
		},
		{
			name:  "WithCounts",
			query: "?limit=5&offset=0&with_counts=true",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					ListMedia(gomock.Any(), db.ListMediaParams{
						Column1: "",
						Column2: int64(0),
						Column3: "",
						Column4: "date_desc",
						Limit:   5,
						Offset:  0,
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
					Return([]db.ListMediaRow{}, sql.ErrConnDone)
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
	searchResultsRow := []db.SearchMediaByNameRow{
		{
			ID:               media.ID,
			Name:             media.Name,
			Description:      media.Description,
			Alt:              media.Alt,
			MediaPath:        media.MediaPath,
			UserID:           media.UserID,
			CreatedAt:        media.CreatedAt,
			ChangedAt:        media.ChangedAt,
			FileSize:         media.FileSize,
			MimeType:         media.MimeType,
			Width:            media.Width,
			Height:           media.Height,
			Duration:         media.Duration,
			OriginalFilename: media.OriginalFilename,
			Metadata:         media.Metadata,
			PostCount:        0,
		},
	}
	searchResults := []db.Medium{searchMediaByNameRowToMedium(searchResultsRow[0])}

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
						Column2: "",
						Column3: int64(0),
						Column4: "date_desc",
						Limit:   10,
						Offset:  0,
					}).
					Times(1).
					Return(searchResultsRow, nil)
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

	// Distinct callers for the ownership policy cases; none of them uploaded
	// othersMedia.
	admin := db.User{ID: 9002, Username: "admin", Role: RoleAdmin}
	otherEditor := db.User{ID: 9003, Username: "editor", Role: RoleEditor}
	contributor := db.User{ID: 9004, Username: "contributor", Role: RoleContributor}
	othersMedia := randomMedia()
	othersMedia.UserID = 9001

	// moderatorUpdates stubs a moderator role editing media it does not own,
	// which must succeed.
	moderatorUpdates := func(store *mockdb.MockStore) {
		store.EXPECT().
			GetMedia(gomock.Any(), gomock.Eq(othersMedia.ID)).
			Times(1).
			Return(othersMedia, nil)

		updatedMedia := othersMedia
		updatedMedia.Name = newName
		store.EXPECT().
			UpdateMedia(gomock.Any(), gomock.Any()).
			Times(1).
			Return(updatedMedia, nil)
	}

	testCases := []struct {
		name          string
		mediaID       int64
		caller        db.User
		body          gin.H
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:    "AdminUpdatesOthersMedia",
			mediaID: othersMedia.ID,
			caller:  admin,
			body:    gin.H{"name": newName},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, admin.ID, admin.Username, time.Minute)
			},
			buildStubs: moderatorUpdates,
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name:    "EditorUpdatesOthersMedia",
			mediaID: othersMedia.ID,
			caller:  otherEditor,
			body:    gin.H{"name": newName},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, otherEditor.ID, otherEditor.Username, time.Minute)
			},
			buildStubs: moderatorUpdates,
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name:    "ContributorBlockedByMiddleware",
			mediaID: othersMedia.ID,
			caller:  contributor,
			body:    gin.H{"name": newName},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, contributor.ID, contributor.Username, time.Minute)
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
				require.Equal(t, http.StatusForbidden, recorder.Code)
			},
		},
		{
			name:    "OK",
			mediaID: media.ID,
			caller:  user,
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
			caller:  user,
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
			caller:  user,
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
			stubRoleLookup(store, tc.caller)

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

	// Distinct callers for the ownership policy cases. owner (an editor)
	// uploaded ownedMedia; admin/editor/contributor did not. The owner-scoped
	// (non-moderator) path is covered by TestMediaWriteOwnerScopedRole.
	owner := db.User{ID: 9001, Username: "owner", Role: RoleEditor}
	admin := db.User{ID: 9002, Username: "admin", Role: RoleAdmin}
	otherEditor := db.User{ID: 9003, Username: "editor", Role: RoleEditor}
	contributor := db.User{ID: 9004, Username: "contributor", Role: RoleContributor}
	ownedMedia := randomMedia()
	ownedMedia.UserID = owner.ID

	testCases := []struct {
		name          string
		mediaID       int64
		caller        db.User
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:    "OK",
			mediaID: media.ID,
			caller:  user,
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
			name:    "EditorDeletesOwnMedia",
			mediaID: ownedMedia.ID,
			caller:  owner,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, owner.ID, owner.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetMedia(gomock.Any(), gomock.Eq(ownedMedia.ID)).
					Times(1).
					Return(ownedMedia, nil)

				store.EXPECT().
					DeleteMediaTx(gomock.Any(), gomock.Eq(db.DeleteMediaTxParams{
						MediaID:  ownedMedia.ID,
						UserID:   owner.ID,
						AnyOwner: true,
					})).
					Times(1).
					Return(nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name:    "AdminDeletesOthersMedia",
			mediaID: ownedMedia.ID,
			caller:  admin,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, admin.ID, admin.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetMedia(gomock.Any(), gomock.Eq(ownedMedia.ID)).
					Times(1).
					Return(ownedMedia, nil)

				// AnyOwner must be set or the store's ownership check would
				// reject the moderation delete.
				store.EXPECT().
					DeleteMediaTx(gomock.Any(), gomock.Eq(db.DeleteMediaTxParams{
						MediaID:  ownedMedia.ID,
						UserID:   admin.ID,
						AnyOwner: true,
					})).
					Times(1).
					Return(nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name:    "EditorDeletesOthersMedia",
			mediaID: ownedMedia.ID,
			caller:  otherEditor,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, otherEditor.ID, otherEditor.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetMedia(gomock.Any(), gomock.Eq(ownedMedia.ID)).
					Times(1).
					Return(ownedMedia, nil)

				store.EXPECT().
					DeleteMediaTx(gomock.Any(), gomock.Eq(db.DeleteMediaTxParams{
						MediaID:  ownedMedia.ID,
						UserID:   otherEditor.ID,
						AnyOwner: true,
					})).
					Times(1).
					Return(nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name:    "ContributorBlockedByMiddleware",
			mediaID: ownedMedia.ID,
			caller:  contributor,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, contributor.ID, contributor.Username, time.Minute)
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
				require.Equal(t, http.StatusForbidden, recorder.Code)
			},
		},
		{
			name:    "NoAuthorization",
			mediaID: media.ID,
			caller:  user,
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
			caller:  user,
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
			// The row vanished between the handler's read and the transaction.
			name:    "DeletedConcurrently",
			mediaID: media.ID,
			caller:  user,
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
					Return(sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:    "StoreError",
			mediaID: media.ID,
			caller:  user,
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
					Return(sql.ErrConnDone)
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
			stubRoleLookup(store, tc.caller)

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

// TestMediaWriteOwnerScopedRole covers the non-moderator branch of the media
// ownership policy. requireContentEditor keeps every such role off the real
// routes today, so the handlers are mounted on synthetic routes behind
// authMiddleware only, as a role admitted to these routes later would see them.
func TestMediaWriteOwnerScopedRole(t *testing.T) {
	contributor := db.User{ID: 9101, Username: "contributor", Role: RoleContributor}

	ownMedia := randomMedia()
	ownMedia.ID = 501
	ownMedia.UserID = contributor.ID
	othersMedia := randomMedia()
	othersMedia.ID = 502
	othersMedia.UserID = 9102

	ownerScopedDelete := func(mediaID int64) db.DeleteMediaTxParams {
		return db.DeleteMediaTxParams{MediaID: mediaID, UserID: contributor.ID, AnyOwner: false}
	}

	testCases := []struct {
		name         string
		method       string
		mediaID      int64
		buildStubs   func(store *mockdb.MockStore)
		expectedCode int
	}{
		{
			name:    "UpdateOwnMedia",
			method:  http.MethodPut,
			mediaID: ownMedia.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetMedia(gomock.Any(), gomock.Eq(ownMedia.ID)).Times(1).Return(ownMedia, nil)
				store.EXPECT().UpdateMedia(gomock.Any(), gomock.Any()).Times(1).Return(ownMedia, nil)
			},
			expectedCode: http.StatusOK,
		},
		{
			name:    "UpdateOthersMediaForbidden",
			method:  http.MethodPut,
			mediaID: othersMedia.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetMedia(gomock.Any(), gomock.Eq(othersMedia.ID)).Times(1).Return(othersMedia, nil)
				store.EXPECT().UpdateMedia(gomock.Any(), gomock.Any()).Times(0)
			},
			expectedCode: http.StatusForbidden,
		},
		{
			name:    "DeleteOwnMedia",
			method:  http.MethodDelete,
			mediaID: ownMedia.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetMedia(gomock.Any(), gomock.Eq(ownMedia.ID)).Times(1).Return(ownMedia, nil)
				store.EXPECT().
					DeleteMediaTx(gomock.Any(), gomock.Eq(ownerScopedDelete(ownMedia.ID))).
					Times(1).
					Return(nil)
			},
			expectedCode: http.StatusOK,
		},
		{
			name:    "DeleteOthersMediaForbidden",
			method:  http.MethodDelete,
			mediaID: othersMedia.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetMedia(gomock.Any(), gomock.Eq(othersMedia.ID)).Times(1).Return(othersMedia, nil)
				store.EXPECT().DeleteMediaTx(gomock.Any(), gomock.Any()).Times(0)
			},
			expectedCode: http.StatusForbidden,
		},
		{
			// Ownership moved (e.g. user transfer) between the handler's read
			// and the transaction: the store's re-check maps to 403, not 500.
			name:    "DeleteOwnerChangedConcurrently",
			method:  http.MethodDelete,
			mediaID: ownMedia.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetMedia(gomock.Any(), gomock.Eq(ownMedia.ID)).Times(1).Return(ownMedia, nil)
				store.EXPECT().
					DeleteMediaTx(gomock.Any(), gomock.Eq(ownerScopedDelete(ownMedia.ID))).
					Times(1).
					Return(fmt.Errorf("user %d, media %d: %w", contributor.ID, ownMedia.ID, db.ErrMediaNotOwned))
			},
			expectedCode: http.StatusForbidden,
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)
			stubRoleLookup(store, contributor)

			server := newTestServer(t, store)
			auth := authMiddleware(server.tokenMaker, server.store)
			server.router.PUT("/owner-scoped/media/:id", auth, server.updateMedia)
			server.router.DELETE("/owner-scoped/media/:id", auth, server.deleteMedia)

			var body io.Reader
			if tc.method == http.MethodPut {
				body = strings.NewReader(`{"name":"renamed"}`)
			}
			url := fmt.Sprintf("/owner-scoped/media/%d", tc.mediaID)
			request, err := http.NewRequest(tc.method, url, body)
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")
			addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, contributor.ID, contributor.Username, time.Minute)

			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, request)
			require.Equal(t, tc.expectedCode, recorder.Code)
		})
	}
}

// TestDeleteMediaRemovesFile checks that a successful delete removes the
// stored file, and that a media_path outside the upload directory is left
// alone without failing the request.
func TestDeleteMediaRemovesFile(t *testing.T) {
	admin := db.User{ID: 9201, Username: "admin", Role: RoleAdmin}

	testCases := []struct {
		name       string
		insideDir  bool
		createFile bool
		expectGone bool
	}{
		{name: "FileInUploadDirRemoved", insideDir: true, createFile: true, expectGone: true},
		{name: "MissingFileStillOK", insideDir: true, createFile: false, expectGone: true},
		{name: "PathOutsideUploadDirKept", insideDir: false, createFile: true, expectGone: false},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			server := newTestServer(t, store)

			dir := server.config.UploadPath
			if !tc.insideDir {
				dir = t.TempDir()
			}
			filePath := filepath.Join(dir, "upload.jpg")
			if tc.createFile {
				require.NoError(t, os.WriteFile(filePath, []byte("img"), 0644))
			}

			media := randomMedia()
			media.MediaPath = filePath

			store.EXPECT().GetMedia(gomock.Any(), gomock.Eq(media.ID)).Times(1).Return(media, nil)
			store.EXPECT().DeleteMediaTx(gomock.Any(), gomock.Any()).Times(1).Return(nil)
			stubRoleLookup(store, admin)

			request, err := http.NewRequest(http.MethodDelete, fmt.Sprintf("/api/v1/media/%d", media.ID), nil)
			require.NoError(t, err)
			addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, admin.ID, admin.Username, time.Minute)

			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, request)
			require.Equal(t, http.StatusOK, recorder.Code)

			_, statErr := os.Stat(filePath)
			if tc.expectGone {
				require.True(t, os.IsNotExist(statErr), "file should be removed")
			} else {
				require.NoError(t, statErr, "file outside the upload dir must not be removed")
			}
		})
	}
}

// TestRemoveMediaFile pins the upload-directory confinement: media_path is
// client-editable, so anything resolving outside the directory is refused.
func TestRemoveMediaFile(t *testing.T) {
	root := t.TempDir()
	uploadDir := filepath.Join(root, "uploads", "media")
	sibling := filepath.Join(root, "uploads", "media2")
	require.NoError(t, os.MkdirAll(uploadDir, 0755))
	require.NoError(t, os.MkdirAll(sibling, 0755))

	inside := filepath.Join(uploadDir, "a.jpg")
	escaped := filepath.Join(root, "secret.env")
	siblingFile := filepath.Join(sibling, "b.jpg")
	for _, p := range []string{inside, escaped, siblingFile} {
		require.NoError(t, os.WriteFile(p, []byte("x"), 0644))
	}

	require.NoError(t, removeMediaFile(uploadDir, inside))
	_, err := os.Stat(inside)
	require.True(t, os.IsNotExist(err))

	require.NoError(t, removeMediaFile(uploadDir, filepath.Join(uploadDir, "missing.jpg")))

	for _, p := range []string{
		filepath.Join(uploadDir, "..", "..", "secret.env"),
		escaped,
		siblingFile,
		uploadDir,
	} {
		require.ErrorIs(t, removeMediaFile(uploadDir, p), errOutsideUploadDir, p)
	}
	for _, p := range []string{escaped, siblingFile} {
		_, err := os.Stat(p)
		require.NoError(t, err, "%s must survive", p)
	}
}

func TestGetMediaByUserAPI(t *testing.T) {
	user := randomUserForPosts()
	media := randomMedia()
	media.UserID = user.ID

	userMediaRow := []db.GetMediaByUserRow{
		{
			ID:               media.ID,
			Name:             media.Name,
			Description:      media.Description,
			Alt:              media.Alt,
			MediaPath:        media.MediaPath,
			UserID:           media.UserID,
			CreatedAt:        media.CreatedAt,
			ChangedAt:        media.ChangedAt,
			FileSize:         media.FileSize,
			MimeType:         media.MimeType,
			Width:            media.Width,
			Height:           media.Height,
			Duration:         media.Duration,
			OriginalFilename: media.OriginalFilename,
			Metadata:         media.Metadata,
			PostCount:        0,
		},
	}
	userMedia := []db.Medium{getMediaByUserRowToMedium(userMediaRow[0])}

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
						UserID:  user.ID,
						Column2: "",
						Column3: "",
						Column4: "date_desc",
						Limit:   10,
						Offset:  0,
					}).
					Times(1).
					Return(userMediaRow, nil)
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

func requireBodyMatchMediaWithCount(t *testing.T, body string, media []db.ListMediaRow, expectedTotal int64) {
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
