package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"
)

func TestPublicMediaPath(t *testing.T) {
	abs := filepath.Join(t.TempDir(), "app", "uploads", "media")

	testCases := []struct {
		name       string
		uploadPath string
		mediaPath  string
		want       string
	}{
		// What uploads and the seed store (UPLOAD_PATH + "/" + file name).
		{"absolute upload path", abs, abs + "/hero.png", "/uploads/media/hero.png"},
		{"relative upload path", "./uploads/media", "./uploads/media/hero.png", "/uploads/media/hero.png"},
		{"relative without dot", "uploads/media", "uploads/media/a b.jpg", "/uploads/media/a b.jpg"},
		{"nested", abs, abs + "/2026/hero.png", "/uploads/media/2026/hero.png"},
		// Not inside UPLOAD_PATH: legacy rows are left as they are.
		{"already a URL path", abs, "/uploads/media/hero.png", "/uploads/media/hero.png"},
		{"outside", abs, filepath.Join(filepath.Dir(abs), "app.env"), filepath.Join(filepath.Dir(abs), "app.env")},
		{"traversal", abs, abs + "/../../app.env", abs + "/../../app.env"},
		{"absolute URL", abs, "https://cdn.example.com/x.png", "https://cdn.example.com/x.png"},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, publicMediaPath(tc.uploadPath, tc.mediaPath))
		})
	}
}

// The admin uses the response's media_path as the image URL, so a stored
// file must come back as the path /uploads serves it at, and that path must
// actually serve the file.
func TestGetMediaReturnsServedPath(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	server := newTestServer(t, store)

	content := testPNG(t, 2, 2)
	require.NoError(t, os.WriteFile(filepath.Join(server.config.UploadPath, "pic.png"), content, 0644))

	media := randomMedia()
	media.MediaPath = server.config.UploadPath + "/pic.png"
	store.EXPECT().GetMedia(gomock.Any(), gomock.Eq(media.ID)).Times(1).Return(media, nil)

	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/v1/media/%d", media.ID), nil))
	require.Equal(t, http.StatusOK, recorder.Code)

	var body struct {
		Media MediaResponse `json:"media"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	require.Equal(t, "/uploads/media/pic.png", body.Media.MediaPath)

	recorder = httptest.NewRecorder()
	server.router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, body.Media.MediaPath, nil))
	require.Equal(t, http.StatusOK, recorder.Code)
	require.Equal(t, content, recorder.Body.Bytes())
}

// The media library lists through the row presenters, not toMediaResponse.
func TestListMediaReturnsServedPaths(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	server := newTestServer(t, store)

	rows := []db.ListMediaRow{
		{ID: 1, MediaPath: server.config.UploadPath + "/a.png"},
		{ID: 2, MediaPath: "/uploads/media/legacy.png"},
	}
	store.EXPECT().ListMedia(gomock.Any(), gomock.Any()).Times(1).Return(rows, nil)
	store.EXPECT().CountTotalMedia(gomock.Any()).Times(1).Return(int64(2), nil)

	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/media", nil))
	require.Equal(t, http.StatusOK, recorder.Code)

	var body struct {
		Media []MediaResponse `json:"media"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	require.Len(t, body.Media, 2)
	require.Equal(t, "/uploads/media/a.png", body.Media[0].MediaPath)
	require.Equal(t, "/uploads/media/legacy.png", body.Media[1].MediaPath)
}
