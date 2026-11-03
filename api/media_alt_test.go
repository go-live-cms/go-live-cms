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

	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Missing alt text (#325): the media list filter, the count for Home, and
// uploads and updates that leave alt empty or mark an image decorative. The
// SQL rule itself (whitespace, decorative, images only, published posts) is
// tested against Postgres in db/sqlc/media_alt_test.go.

func TestListMediaMissingAltFilter(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	server := newTestServer(t, store)

	rows := []db.ListMediaRow{
		{ID: 1, MimeType: "image/png", Alt: "", PostCount: 3, PublishedPostCount: 2},
	}
	store.EXPECT().ListMedia(gomock.Any(), db.ListMediaParams{
		Column1: "image/",
		Column2: int64(0),
		Column3: "",
		Column4: "date_desc",
		Limit:   24,
		Offset:  0,
		Column7: true,
	}).Times(1).Return(rows, nil)
	// The total follows the same filters, so "Load more" ends with the list.
	store.EXPECT().CountMedia(gomock.Any(), db.CountMediaParams{
		MimePrefix: "image/",
		MissingAlt: true,
	}).Times(1).Return(int64(1), nil)

	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/media?limit=24&type=image&missing_alt=true", nil))
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())

	var body struct {
		Media []MediaResponse `json:"media"`
		Meta  struct {
			Total   int64 `json:"total"`
			Filters struct {
				MissingAlt bool `json:"missing_alt"`
			} `json:"filters"`
		} `json:"meta"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	require.Len(t, body.Media, 1)
	require.Equal(t, int64(3), *body.Media[0].PostCount)
	require.Equal(t, int64(2), *body.Media[0].PublishedPostCount)
	require.Equal(t, int64(1), body.Meta.Total)
	require.True(t, body.Meta.Filters.MissingAlt)
}

func TestListMediaMissingAltInvalid(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	server := newTestServer(t, store)
	store.EXPECT().ListMedia(gomock.Any(), gomock.Any()).Times(0)

	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/media?missing_alt=maybe", nil))
	require.Equal(t, http.StatusBadRequest, recorder.Code)
}

func TestListMediaCountError(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	server := newTestServer(t, store)
	store.EXPECT().ListMedia(gomock.Any(), gomock.Any()).Return([]db.ListMediaRow{}, nil)
	store.EXPECT().CountMedia(gomock.Any(), gomock.Any()).Return(int64(0), sql.ErrConnDone)

	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/media", nil))
	require.Equal(t, http.StatusInternalServerError, recorder.Code)
}

func TestMissingAltSummaryAPI(t *testing.T) {
	contributor := db.User{ID: 9501, Username: "contributor", Role: RoleContributor}

	testCases := []struct {
		name       string
		auth       bool
		buildStubs func(store *mockdb.MockStore)
		wantCode   int
		wantBody   string
	}{
		{
			name: "OK",
			auth: true,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().CountMissingAltMedia(gomock.Any()).Times(1).
					Return(db.CountMissingAltMediaRow{MediaCount: 3, PublishedPostCount: 2}, nil)
			},
			wantCode: http.StatusOK,
			wantBody: `{"media_count":3,"published_post_count":2}`,
		},
		{
			name: "NoAuthorization",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().CountMissingAltMedia(gomock.Any()).Times(0)
			},
			wantCode: http.StatusUnauthorized,
		},
		{
			name: "InternalError",
			auth: true,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().CountMissingAltMedia(gomock.Any()).Times(1).
					Return(db.CountMissingAltMediaRow{}, sql.ErrConnDone)
			},
			wantCode: http.StatusInternalServerError,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)
			stubRoleLookup(store, contributor)
			server := newTestServer(t, store)

			request := httptest.NewRequest(http.MethodGet, "/api/v1/media/missing-alt", nil)
			if tc.auth {
				addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, contributor.ID, contributor.Username, time.Minute)
			}
			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, request)
			require.Equal(t, tc.wantCode, recorder.Code, recorder.Body.String())
			if tc.wantBody != "" {
				require.JSONEq(t, tc.wantBody, recorder.Body.String())
			}
		})
	}
}

// uploadWithFields is a POST /media of a small PNG with the given form fields.
func uploadWithFields(t *testing.T, fields map[string]string) *http.Request {
	t.Helper()
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	for k, v := range fields {
		require.NoError(t, writer.WriteField(k, v))
	}
	part, err := writer.CreateFormFile("file", "team-photo.png")
	require.NoError(t, err)
	_, err = part.Write(testPNG(t, 4, 4))
	require.NoError(t, err)
	require.NoError(t, writer.Close())
	request, err := http.NewRequest(http.MethodPost, "/api/v1/media", body)
	require.NoError(t, err)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	return request
}

func TestCreateMediaAltOptional(t *testing.T) {
	editor := db.User{ID: 9502, Username: "editor", Role: RoleEditor}

	testCases := []struct {
		name           string
		fields         map[string]string
		wantAlt        string
		wantDecorative bool
	}{
		// Before #325 alt was required, and an empty one became the file name.
		{"NoAlt", map[string]string{}, "", false},
		{"WhitespaceAlt", map[string]string{"alt": "  \t "}, "", false},
		{"TrimmedAlt", map[string]string{"alt": "  Three people at a desk "}, "Three people at a desk", false},
		{"Decorative", map[string]string{"decorative": "true"}, "", true},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			stubRoleLookup(store, editor)
			server := newTestServer(t, store)

			store.EXPECT().CreateMedia(gomock.Any(), gomock.Any()).Times(1).
				DoAndReturn(func(_ any, arg db.CreateMediaParams) (db.Medium, error) {
					require.Equal(t, tc.wantAlt, arg.Alt)
					require.Equal(t, tc.wantDecorative, arg.Decorative)
					return db.Medium{ID: 1, Alt: arg.Alt, Decorative: arg.Decorative, MediaPath: arg.MediaPath, MimeType: arg.MimeType}, nil
				})

			fields := map[string]string{"name": "Team photo", "description": "The team in October"}
			for k, v := range tc.fields {
				fields[k] = v
			}
			request := uploadWithFields(t, fields)
			addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, editor.ID, editor.Username, time.Minute)
			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, request)
			require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())

			var body struct{ Media MediaResponse }
			require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
			require.Equal(t, tc.wantDecorative, body.Media.Decorative)
		})
	}
}

func TestCreateMediaAltTooLong(t *testing.T) {
	editor := db.User{ID: 9503, Username: "editor", Role: RoleEditor}
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	stubRoleLookup(store, editor)
	server := newTestServer(t, store)
	store.EXPECT().CreateMedia(gomock.Any(), gomock.Any()).Times(0)

	long := make([]byte, 256)
	for i := range long {
		long[i] = 'a'
	}
	request := uploadWithFields(t, map[string]string{"name": "Team photo", "description": "The team in October", "alt": string(long)})
	addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, editor.ID, editor.Username, time.Minute)
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusBadRequest, recorder.Code)
}

func TestCreateMediaWithPostLinkKeepsDecorative(t *testing.T) {
	editor := db.User{ID: 9504, Username: "editor", Role: RoleEditor}
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	stubRoleLookup(store, editor)
	server := newTestServer(t, store)

	store.EXPECT().CreateMediaAndLinkTx(gomock.Any(), gomock.Any()).Times(1).
		DoAndReturn(func(_ any, arg db.CreateMediaAndLinkTxParams) (db.CreateMediaAndLinkTxResult, error) {
			require.True(t, arg.Decorative)
			require.Empty(t, arg.Alt)
			return db.CreateMediaAndLinkTxResult{Media: db.Medium{ID: 2, Decorative: true}}, nil
		})

	request := uploadWithFields(t, map[string]string{"name": "Divider", "description": "A wavy divider", "decorative": "true", "post_id": "7"})
	addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, editor.ID, editor.Username, time.Minute)
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
}

func TestBulkUploadLeavesAltEmpty(t *testing.T) {
	editor := db.User{ID: 9505, Username: "editor", Role: RoleEditor}
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	stubRoleLookup(store, editor)
	server := newTestServer(t, store)

	store.EXPECT().CreateMedia(gomock.Any(), gomock.Any()).Times(1).
		DoAndReturn(func(_ any, arg db.CreateMediaParams) (db.Medium, error) {
			require.Empty(t, arg.Alt, "the file name is not alt text")
			return db.Medium{ID: 3, MediaPath: arg.MediaPath}, nil
		})

	request := bulkUploadRequest(t, "/api/v1/media/bulk", []string{"sunset-photo.png"})
	addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, editor.ID, editor.Username, time.Minute)
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
}

func TestUpdateMediaAltAndDecorative(t *testing.T) {
	editor := db.User{ID: 9506, Username: "editor", Role: RoleEditor}

	testCases := []struct {
		name string
		body gin.H
		want db.UpdateMediaMetadataParams
	}{
		{
			// Absent keeps both.
			name: "NameOnly",
			body: gin.H{"name": "Renamed"},
			want: db.UpdateMediaMetadataParams{ID: 40, Name: sql.NullString{String: "Renamed", Valid: true}},
		},
		{
			// "" clears alt (it used to mean "keep").
			name: "ClearAlt",
			body: gin.H{"alt": ""},
			want: db.UpdateMediaMetadataParams{ID: 40, Alt: sql.NullString{String: "", Valid: true}},
		},
		{
			name: "WhitespaceAltClears",
			body: gin.H{"alt": " \n\t "},
			want: db.UpdateMediaMetadataParams{ID: 40, Alt: sql.NullString{String: "", Valid: true}},
		},
		{
			name: "AltTrimmed",
			body: gin.H{"alt": "  A red roof on a green hill  "},
			want: db.UpdateMediaMetadataParams{ID: 40, Alt: sql.NullString{String: "A red roof on a green hill", Valid: true}},
		},
		{
			name: "MarkDecorative",
			body: gin.H{"decorative": true},
			want: db.UpdateMediaMetadataParams{ID: 40, Decorative: sql.NullBool{Bool: true, Valid: true}},
		},
		{
			name: "UnmarkDecorative",
			body: gin.H{"decorative": false, "alt": "A wavy line"},
			want: db.UpdateMediaMetadataParams{
				ID:         40,
				Alt:        sql.NullString{String: "A wavy line", Valid: true},
				Decorative: sql.NullBool{Bool: false, Valid: true},
			},
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			store.EXPECT().UpdateMediaMetadata(gomock.Any(), gomock.Eq(tc.want)).Times(1).
				Return(db.Medium{ID: 40, Decorative: tc.want.Decorative.Bool}, nil)
			stubRoleLookup(store, editor)
			server := newTestServer(t, store)

			data, err := json.Marshal(tc.body)
			require.NoError(t, err)
			request := httptest.NewRequest(http.MethodPut, fmt.Sprintf("/api/v1/media/%d", 40), bytes.NewReader(data))
			request.Header.Set("Content-Type", "application/json")
			addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, editor.ID, editor.Username, time.Minute)
			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, request)
			require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		})
	}
}

func TestUpdateMediaRejectsBadDecorative(t *testing.T) {
	editor := db.User{ID: 9507, Username: "editor", Role: RoleEditor}
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	store.EXPECT().UpdateMediaMetadata(gomock.Any(), gomock.Any()).Times(0)
	stubRoleLookup(store, editor)
	server := newTestServer(t, store)

	request := httptest.NewRequest(http.MethodPut, "/api/v1/media/40", bytes.NewReader([]byte(`{"decorative":"yes"}`)))
	request.Header.Set("Content-Type", "application/json")
	addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, editor.ID, editor.Username, time.Minute)
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusBadRequest, recorder.Code)
}
