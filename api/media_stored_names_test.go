package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// requireStoredName checks that stored is original's stored form (#399):
// the readable name, a dash, 32 hex chars of randomness, the extension.
func requireStoredName(t *testing.T, original, stored string) {
	t.Helper()
	ext := filepath.Ext(original)
	pattern := "^" + regexp.QuoteMeta(strings.TrimSuffix(original, ext)) + "-[0-9a-f]{32}" + regexp.QuoteMeta(ext) + "$"
	require.Regexp(t, pattern, stored)
}

var storedNameToken = regexp.MustCompile(`-[0-9a-f]{32}(\.[^.]*)?$`)

// uploadedOriginalNames lists the upload directory like uploadedFiles, with
// each stored name's random token removed ("photo-<hex>.png" → "photo.png").
// Fixture files written under a plain name are listed as they are.
func uploadedOriginalNames(t *testing.T, server *Server) []string {
	t.Helper()
	names := uploadedFiles(t, server)
	for i, name := range names {
		names[i] = storedNameToken.ReplaceAllString(name, "$1")
	}
	return names
}

func TestCleanUploadFilename(t *testing.T) {
	testCases := map[string]string{
		"launch-announcement.jpg": "launch-announcement.jpg",
		"My Photo (1).JPG":        "My_Photo_1.JPG",
		"../../etc/hero.png":      ".._.._etc_hero.png",
		"_hidden.png":             "hidden.png",
		"???.png":                 "untitled.png",
	}
	for in, want := range testCases {
		require.Equal(t, want, cleanUploadFilename(in), in)
	}
}

func TestStoredFileName(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 50; i++ {
		name, err := storedFileName("launch-announcement.jpg")
		require.NoError(t, err)
		requireStoredName(t, "launch-announcement.jpg", name)
		require.False(t, seen[name], "every upload gets its own name")
		seen[name] = true
	}

	name, err := storedFileName("README")
	require.NoError(t, err)
	require.Regexp(t, `^README-[0-9a-f]{32}$`, name)

	// cleanFilename trims leading underscores and the token follows a dash,
	// so no stored name can collide with the _variants directory.
	name, err = storedFileName(cleanUploadFilename("_variants.png"))
	require.NoError(t, err)
	require.False(t, strings.HasPrefix(name, "_"), name)
}

// failingReader returns some bytes and then an error, like a client that
// hangs up mid-upload.
type failingReader struct{ sent bool }

func (r *failingReader) Read(p []byte) (int, error) {
	if r.sent {
		return 0, errors.New("connection reset")
	}
	r.sent = true
	return copy(p, "partial"), nil
}

func TestSaveUploadedFile(t *testing.T) {
	t.Run("SameNameTwiceKeepsBoth", func(t *testing.T) {
		dir := filepath.Join(t.TempDir(), "uploads", "media")

		first, err := saveUploadedFile(strings.NewReader("first"), "hero.png", dir)
		require.NoError(t, err)
		second, err := saveUploadedFile(strings.NewReader("second"), "hero.png", dir)
		require.NoError(t, err)

		require.NotEqual(t, first, second)
		for path, content := range map[string]string{first: "first", second: "second"} {
			require.Equal(t, dir, filepath.Dir(path), "media_path is <UPLOAD_PATH>/<file>")
			requireStoredName(t, "hero.png", filepath.Base(path))
			stored, err := os.ReadFile(path)
			require.NoError(t, err)
			require.Equal(t, content, string(stored))
		}
		_, err = os.Stat(filepath.Join(dir, "hero.png"))
		require.True(t, os.IsNotExist(err), "the readable name alone is never stored")
	})

	t.Run("FailedWriteLeavesNoFile", func(t *testing.T) {
		dir := t.TempDir()
		_, err := saveUploadedFile(&failingReader{}, "hero.png", dir)
		require.Error(t, err)
		entries, err := os.ReadDir(dir)
		require.NoError(t, err)
		require.Empty(t, entries)
	})

	t.Run("UnwritableDirectory", func(t *testing.T) {
		file := filepath.Join(t.TempDir(), "not-a-dir")
		require.NoError(t, os.WriteFile(file, nil, 0644))
		_, err := saveUploadedFile(strings.NewReader("x"), "hero.png", filepath.Join(file, "media"))
		require.Error(t, err)
	})
}

// An image only a draft uses must not be reachable by guessing its name
// (#399): the upload is served at its random URL, never at the uploader's
// file name, and /uploads lists no directory.
func TestUploadedFileURLIsUnguessable(t *testing.T) {
	editor := db.User{ID: 9901, Username: "editor", Role: RoleEditor}
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	server := newTestServerWithMaxUpload(t, store, "10MB")
	stubRoleLookup(store, editor)

	store.EXPECT().CreateMedia(gomock.Any(), gomock.Any()).
		DoAndReturn(func(_ context.Context, arg db.CreateMediaParams) (db.Medium, error) {
			require.Equal(t, "launch-announcement.jpg", arg.OriginalFilename, "original_filename keeps the readable name")
			requireStoredName(t, "launch-announcement.jpg", filepath.Base(arg.MediaPath))
			return db.Medium{ID: 9, MediaPath: arg.MediaPath, MimeType: arg.MimeType, OriginalFilename: arg.OriginalFilename, Variants: arg.Variants.RawMessage}, nil
		})

	request := createMediaRequest(t, "launch-announcement.jpg", testJPEG(t, 1000, 800))
	addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, editor.ID, editor.Username, time.Minute)
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())

	var rsp struct{ Media MediaResponse }
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
	require.Regexp(t, `^/uploads/media/launch-announcement-[0-9a-f]{32}\.jpg$`, rsp.Media.MediaPath)
	require.Contains(t, rsp.Media.Variants, "thumb")

	get := func(url string) int {
		recorder := httptest.NewRecorder()
		server.router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, url, nil))
		return recorder.Code
	}
	require.Equal(t, http.StatusOK, get(rsp.Media.MediaPath))
	require.Equal(t, http.StatusOK, get(rsp.Media.Variants["thumb"].Path), "variants are served under the stored name")

	stored := filepath.Base(rsp.Media.MediaPath)
	for _, guess := range []string{
		"/uploads/media/launch-announcement.jpg",
		"/uploads/media/launch-announcement_1.jpg",
		"/uploads/media/_variants/launch-announcement.jpg/thumb.jpg",
		"/uploads/media/",
		"/uploads/media/_variants/",
		"/uploads/media/_variants/" + stored + "/",
	} {
		require.Equal(t, http.StatusNotFound, get(guess), guess)
	}
}

// A bulk upload has no name field: the default name and description come
// from the readable file name, not the stored one.
func TestCreateMediaBulkUsesReadableNames(t *testing.T) {
	editor := db.User{ID: 9902, Username: "editor", Role: RoleEditor}
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	server := newTestServer(t, store)
	stubRoleLookup(store, editor)

	var stored []string
	store.EXPECT().CreateMedia(gomock.Any(), gomock.Any()).Times(2).
		DoAndReturn(func(_ context.Context, arg db.CreateMediaParams) (db.Medium, error) {
			require.Equal(t, "team-photo", arg.Name)
			require.Equal(t, "team-photo.png", arg.OriginalFilename)
			require.Equal(t, "Uploaded file: team-photo.png", arg.Description)
			requireStoredName(t, "team-photo.png", filepath.Base(arg.MediaPath))
			stored = append(stored, arg.MediaPath)
			return db.Medium{ID: int64(len(stored)), MediaPath: arg.MediaPath, MimeType: arg.MimeType}, nil
		})

	request := bulkUploadRequest(t, "/api/v1/media/bulk", []string{"team-photo.png", "team-photo.png"})
	addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, editor.ID, editor.Username, time.Minute)
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
	require.Len(t, stored, 2)
	require.NotEqual(t, stored[0], stored[1], "same file name twice gets two stored files")
}
