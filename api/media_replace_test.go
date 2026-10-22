package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// testImage is a w×h image with a distinct pixel, so two encodings of
// different sizes never compare equal.
func testImage(w, h int) image.Image {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	img.Set(0, 0, color.RGBA{R: 200, A: 255})
	return img
}

func testPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	require.NoError(t, png.Encode(&buf, testImage(w, h)))
	return buf.Bytes()
}

func testJPEG(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	require.NoError(t, jpeg.Encode(&buf, testImage(w, h), nil))
	return buf.Bytes()
}

// testFileContent returns bytes that sniff as the type name's extension
// claims (an image for .png/.jpg, text otherwise).
func testFileContent(t *testing.T, name string) []byte {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".png":
		return testPNG(t, 2, 2)
	case ".jpg", ".jpeg":
		return testJPEG(t, 2, 2)
	default:
		return []byte("content of " + name)
	}
}

// fileUploadRequest builds a multipart POST to url with one "file" part
// (none when filename is empty).
func fileUploadRequest(t *testing.T, url, filename string, content []byte) *http.Request {
	t.Helper()
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	if filename != "" {
		part, err := writer.CreateFormFile("file", filename)
		require.NoError(t, err)
		_, err = part.Write(content)
		require.NoError(t, err)
	}
	require.NoError(t, writer.Close())

	request, err := http.NewRequest(http.MethodPost, url, body)
	require.NoError(t, err)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	return request
}

// newTestServerWithMaxUpload is newTestServer with MAX_UPLOAD_SIZE set.
func newTestServerWithMaxUpload(t *testing.T, store db.Store, maxUpload string) *Server {
	t.Helper()
	config := newTestConfig(t)
	config.MaxUploadSize = maxUpload
	server, err := NewServer(config, store)
	require.NoError(t, err)
	return server
}

func TestValidateMediaUpload(t *testing.T) {
	isoMedia := append([]byte{0, 0, 0, 0x18}, []byte("ftypisom\x00\x00\x02\x00isomiso2")...)

	testCases := []struct {
		name     string
		filename string
		content  []byte
		max      int64
		wantMIME string
		wantErr  error
	}{
		{name: "PNG", filename: "a.png", content: testPNG(t, 2, 2), wantMIME: "image/png"},
		{name: "JPEGUppercaseExt", filename: "a.JPG", content: testJPEG(t, 2, 2), wantMIME: "image/jpeg"},
		{name: "MP4", filename: "clip.mp4", content: isoMedia, wantMIME: "video/mp4"},
		{name: "MP3WithID3", filename: "song.mp3", content: []byte("ID3\x04\x00\x00\x00\x00\x00\x00"), wantMIME: "audio/mpeg"},
		{name: "PDF", filename: "doc.pdf", content: []byte("%PDF-1.7\n"), wantMIME: "application/pdf"},
		{name: "PlainText", filename: "notes.txt", content: []byte("just some notes"), wantMIME: "text/plain"},
		{name: "TextRenamedToPNG", filename: "a.png", content: []byte("not an image"), wantErr: errMediaContentMismatch},
		{name: "JPEGRenamedToPNG", filename: "a.png", content: testJPEG(t, 2, 2), wantErr: errMediaContentMismatch},
		{name: "HTMLRenamedToJPG", filename: "a.jpg", content: []byte("<html><script>alert(1)</script></html>"), wantErr: errMediaContentMismatch},
		{name: "HTMLAsText", filename: "page.txt", content: []byte("<!DOCTYPE html><html><body>x</body></html>"), wantErr: errMediaContentMismatch},
		{name: "Empty", filename: "a.png", content: nil, wantErr: errMediaContentMismatch},
		{name: "SVGRefused", filename: "logo.svg", content: []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`), wantErr: errUnsupportedMediaType},
		{name: "ExecutableRefused", filename: "payload.exe", content: []byte("MZ\x90\x00"), wantErr: errUnsupportedMediaType},
		{name: "NoExtension", filename: "README", content: []byte("text"), wantErr: errUnsupportedMediaType},
		{name: "TooLarge", filename: "a.png", content: testPNG(t, 2, 2), max: 10, wantErr: errMediaTooLarge},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			request := fileUploadRequest(t, "/", tc.filename, tc.content)
			require.NoError(t, request.ParseMultipartForm(1<<20))
			file, header, err := request.FormFile("file")
			require.NoError(t, err)
			defer file.Close()

			max := tc.max
			if max == 0 {
				max = 1 << 20
			}
			mime, err := validateMediaUpload(file, header, max)
			if tc.wantErr != nil {
				require.ErrorIs(t, err, tc.wantErr)
				return
			}
			require.NoError(t, err)
			require.Equal(t, tc.wantMIME, mime)

			// Rewound, so saving the file stores all of it.
			var stored bytes.Buffer
			_, err = stored.ReadFrom(file)
			require.NoError(t, err)
			require.Equal(t, tc.content, stored.Bytes())
		})
	}
}

// TestCreateMediaUploadValidation covers POST /media refusing files by
// content and size before anything is stored.
func TestCreateMediaUploadValidation(t *testing.T) {
	editor := db.User{ID: 9501, Username: "editor", Role: RoleEditor}

	testCases := []struct {
		name      string
		maxUpload string
		filename  string
		content   []byte
		wantCode  int
		wantError string
	}{
		{name: "SpoofedImage", filename: "photo.png", content: []byte("#!/bin/sh\nrm -rf /"), wantCode: http.StatusBadRequest, wantError: "does not match its extension"},
		{name: "SVG", filename: "logo.svg", content: []byte("<svg/>"), wantCode: http.StatusBadRequest, wantError: "invalid file type"},
		{name: "OverLimit", maxUpload: "1KB", filename: "big.png", content: append(testPNG(t, 2, 2), make([]byte, 2048)...), wantCode: http.StatusRequestEntityTooLarge, wantError: "Maximum size is 1KB"},
		// Past the body cap (limit + multipart allowance) the parse itself
		// fails, before anything is spooled to disk.
		{name: "BodyOverCap", maxUpload: "1KB", filename: "huge.png", content: append(testPNG(t, 2, 2), make([]byte, 2<<20)...), wantCode: http.StatusRequestEntityTooLarge, wantError: "Maximum size is 1KB"},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()
			store := mockdb.NewMockStore(ctrl)
			store.EXPECT().CreateMedia(gomock.Any(), gomock.Any()).Times(0)
			stubRoleLookup(store, editor)

			server := newTestServerWithMaxUpload(t, store, tc.maxUpload)

			body := &bytes.Buffer{}
			writer := multipart.NewWriter(body)
			for k, v := range map[string]string{"name": "Photo", "description": "A test photo", "alt": "A photo"} {
				require.NoError(t, writer.WriteField(k, v))
			}
			part, err := writer.CreateFormFile("file", tc.filename)
			require.NoError(t, err)
			_, err = part.Write(tc.content)
			require.NoError(t, err)
			require.NoError(t, writer.Close())

			request, err := http.NewRequest(http.MethodPost, "/api/v1/media", body)
			require.NoError(t, err)
			request.Header.Set("Content-Type", writer.FormDataContentType())
			addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, editor.ID, editor.Username, time.Minute)

			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, request)
			require.Equal(t, tc.wantCode, recorder.Code, recorder.Body.String())
			require.Contains(t, recorder.Body.String(), tc.wantError)
			require.Empty(t, uploadedFiles(t, server))
		})
	}
}

func TestCreateMediaBulkRejectsSpoofedFile(t *testing.T) {
	editor := db.User{ID: 9502, Username: "editor", Role: RoleEditor}

	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	store := mockdb.NewMockStore(ctrl)
	store.EXPECT().CreateMedia(gomock.Any(), gomock.Any()).Times(1).
		DoAndReturn(func(_ any, arg db.CreateMediaParams) (db.Medium, error) {
			require.Equal(t, "image/png", arg.MimeType)
			return db.Medium{ID: 1, MediaPath: arg.MediaPath, MimeType: arg.MimeType}, nil
		})
	stubRoleLookup(store, editor)
	server := newTestServer(t, store)

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	for name, content := range map[string][]byte{
		"real.png": testPNG(t, 2, 2),
		"fake.jpg": []byte("<html>not a jpeg</html>"),
	} {
		part, err := writer.CreateFormFile("files", name)
		require.NoError(t, err)
		_, err = part.Write(content)
		require.NoError(t, err)
	}
	require.NoError(t, writer.Close())
	request, err := http.NewRequest(http.MethodPost, "/api/v1/media/bulk", body)
	require.NoError(t, err)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, editor.ID, editor.Username, time.Minute)

	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())

	var rsp bulkUploadResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
	require.Equal(t, 1, rsp.Meta.Successful)
	require.Equal(t, []string{"file content of fake.jpg does not match its extension"}, rsp.Errors)
	require.Equal(t, []string{"real.png"}, uploadedFiles(t, server))
}

// replaceFixture is a stored PNG media row owned by ownerID, with its file
// in the server's upload directory.
func replaceFixture(t *testing.T, server *Server, ownerID int64) (db.Medium, []byte) {
	t.Helper()
	original := testPNG(t, 2, 2)
	path := filepath.Join(server.config.UploadPath, "hero.png")
	require.NoError(t, os.WriteFile(path, original, 0644))
	return db.Medium{
		ID:               701,
		Name:             "Hero image",
		Description:      "Homepage hero",
		Alt:              "A red pixel",
		MediaPath:        path,
		UserID:           ownerID,
		FileSize:         int64(len(original)),
		MimeType:         "image/png",
		Width:            2,
		Height:           2,
		OriginalFilename: "hero.png",
		CreatedAt:        time.Now().Add(-time.Hour),
		ChangedAt:        time.Now().Add(-time.Hour),
	}, original
}

// echoReplace returns media updated the way ReplaceMediaFile would.
func echoReplace(media db.Medium) func(any, db.ReplaceMediaFileParams) (db.Medium, error) {
	return func(_ any, arg db.ReplaceMediaFileParams) (db.Medium, error) {
		media.MediaPath = arg.MediaPath
		media.FileSize = arg.FileSize
		media.MimeType = arg.MimeType
		media.Width = arg.Width
		media.Height = arg.Height
		media.OriginalFilename = arg.OriginalFilename
		media.ChangedAt = time.Now()
		return media, nil
	}
}

func TestReplaceMediaAPI(t *testing.T) {
	admin := db.User{ID: 9601, Username: "admin", Role: RoleAdmin}
	editor := db.User{ID: 9602, Username: "editor", Role: RoleEditor}
	contributor := db.User{ID: 9603, Username: "contributor", Role: RoleContributor}
	const ownerID = 9699

	type fixture struct {
		media    db.Medium
		original []byte
	}

	testCases := []struct {
		name       string
		caller     *db.User
		filename   string
		content    func(t *testing.T) []byte
		mediaID    string
		buildStubs func(t *testing.T, server *Server, store *mockdb.MockStore, fx fixture)
		check      func(t *testing.T, server *Server, recorder *httptest.ResponseRecorder, fx fixture)
	}{
		{
			// The decisive case: same id, name, description and alt; new file
			// at the same path with its own size and dimensions.
			name:     "ReplacesInPlaceKeepingIDAndMetadata",
			caller:   &editor,
			filename: "new hero.png",
			content:  func(t *testing.T) []byte { return testPNG(t, 3, 5) },
			buildStubs: func(t *testing.T, server *Server, store *mockdb.MockStore, fx fixture) {
				store.EXPECT().GetMedia(gomock.Any(), gomock.Eq(fx.media.ID)).Times(1).Return(fx.media, nil)
				store.EXPECT().ReplaceMediaFile(gomock.Any(), gomock.Any()).Times(1).
					DoAndReturn(func(ctx any, arg db.ReplaceMediaFileParams) (db.Medium, error) {
						require.Equal(t, fx.media.ID, arg.ID)
						require.Equal(t, fx.media.MediaPath, arg.MediaPath, "path (and so the URL) is kept")
						require.Equal(t, "image/png", arg.MimeType)
						require.Equal(t, int32(3), arg.Width)
						require.Equal(t, int32(5), arg.Height)
						require.Equal(t, "new_hero.png", arg.OriginalFilename)
						return echoReplace(fx.media)(ctx, arg)
					})
			},
			check: func(t *testing.T, server *Server, recorder *httptest.ResponseRecorder, fx fixture) {
				require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())

				var rsp struct{ Media MediaResponse }
				require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
				require.Equal(t, fx.media.ID, rsp.Media.ID)
				require.Equal(t, fx.media.Name, rsp.Media.Name)
				require.Equal(t, fx.media.Alt, rsp.Media.Alt)
				require.Equal(t, fx.media.Description, rsp.Media.Description)
				require.Equal(t, fx.media.MediaPath, rsp.Media.MediaPath)

				stored, err := os.ReadFile(fx.media.MediaPath)
				require.NoError(t, err)
				require.Equal(t, testPNG(t, 3, 5), stored)
				require.Equal(t, []string{"hero.png"}, uploadedFiles(t, server), "no temp or backup file left")
			},
		},
		{
			name:     "AdminMayReplaceAnyMedia",
			caller:   &admin,
			filename: "other.png",
			content:  func(t *testing.T) []byte { return testPNG(t, 4, 4) },
			buildStubs: func(t *testing.T, server *Server, store *mockdb.MockStore, fx fixture) {
				store.EXPECT().GetMedia(gomock.Any(), gomock.Eq(fx.media.ID)).Times(1).Return(fx.media, nil)
				store.EXPECT().ReplaceMediaFile(gomock.Any(), gomock.Any()).Times(1).DoAndReturn(echoReplace(fx.media))
			},
			check: func(t *testing.T, server *Server, recorder *httptest.ResponseRecorder, fx fixture) {
				require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
			},
		},
		{
			// A failed database update must not lose the original file.
			name:     "UpdateFailureRestoresOriginal",
			caller:   &editor,
			filename: "new.png",
			content:  func(t *testing.T) []byte { return testPNG(t, 3, 5) },
			buildStubs: func(t *testing.T, server *Server, store *mockdb.MockStore, fx fixture) {
				store.EXPECT().GetMedia(gomock.Any(), gomock.Eq(fx.media.ID)).Times(1).Return(fx.media, nil)
				store.EXPECT().ReplaceMediaFile(gomock.Any(), gomock.Any()).Times(1).Return(db.Medium{}, sql.ErrConnDone)
			},
			check: func(t *testing.T, server *Server, recorder *httptest.ResponseRecorder, fx fixture) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
				stored, err := os.ReadFile(fx.media.MediaPath)
				require.NoError(t, err)
				require.Equal(t, fx.original, stored)
				require.Equal(t, []string{"hero.png"}, uploadedFiles(t, server))
			},
		},
		{
			name:     "DifferentTypeRefused",
			caller:   &editor,
			filename: "new.jpg",
			content:  func(t *testing.T) []byte { return testJPEG(t, 3, 5) },
			buildStubs: func(t *testing.T, server *Server, store *mockdb.MockStore, fx fixture) {
				store.EXPECT().GetMedia(gomock.Any(), gomock.Eq(fx.media.ID)).Times(1).Return(fx.media, nil)
				store.EXPECT().ReplaceMediaFile(gomock.Any(), gomock.Any()).Times(0)
			},
			check: func(t *testing.T, server *Server, recorder *httptest.ResponseRecorder, fx fixture) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
				require.Contains(t, recorder.Body.String(), "same file type as the original (image/png")
				stored, err := os.ReadFile(fx.media.MediaPath)
				require.NoError(t, err)
				require.Equal(t, fx.original, stored)
			},
		},
		{
			name:     "SpoofedContentRefused",
			caller:   &editor,
			filename: "new.png",
			content:  func(t *testing.T) []byte { return []byte("<html>gotcha</html>") },
			buildStubs: func(t *testing.T, server *Server, store *mockdb.MockStore, fx fixture) {
				store.EXPECT().GetMedia(gomock.Any(), gomock.Any()).Times(0)
				store.EXPECT().ReplaceMediaFile(gomock.Any(), gomock.Any()).Times(0)
			},
			check: func(t *testing.T, server *Server, recorder *httptest.ResponseRecorder, fx fixture) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
				require.Contains(t, recorder.Body.String(), "does not match its extension")
			},
		},
		{
			name:     "OverLimit",
			caller:   &editor,
			filename: "new.png",
			content:  func(t *testing.T) []byte { return append(testPNG(t, 2, 2), make([]byte, 2048)...) },
			buildStubs: func(t *testing.T, server *Server, store *mockdb.MockStore, fx fixture) {
				store.EXPECT().ReplaceMediaFile(gomock.Any(), gomock.Any()).Times(0)
			},
			check: func(t *testing.T, server *Server, recorder *httptest.ResponseRecorder, fx fixture) {
				require.Equal(t, http.StatusRequestEntityTooLarge, recorder.Code)
			},
		},
		{
			name:     "NoFile",
			caller:   &editor,
			filename: "",
			content:  func(t *testing.T) []byte { return nil },
			buildStubs: func(t *testing.T, server *Server, store *mockdb.MockStore, fx fixture) {
				store.EXPECT().ReplaceMediaFile(gomock.Any(), gomock.Any()).Times(0)
			},
			check: func(t *testing.T, server *Server, recorder *httptest.ResponseRecorder, fx fixture) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
				require.Contains(t, recorder.Body.String(), "file is required")
			},
		},
		{
			name:     "InvalidID",
			caller:   &editor,
			mediaID:  "abc",
			filename: "new.png",
			content:  func(t *testing.T) []byte { return testPNG(t, 2, 2) },
			buildStubs: func(t *testing.T, server *Server, store *mockdb.MockStore, fx fixture) {
				store.EXPECT().GetMedia(gomock.Any(), gomock.Any()).Times(0)
			},
			check: func(t *testing.T, server *Server, recorder *httptest.ResponseRecorder, fx fixture) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name:     "NotFound",
			caller:   &editor,
			filename: "new.png",
			content:  func(t *testing.T) []byte { return testPNG(t, 2, 2) },
			buildStubs: func(t *testing.T, server *Server, store *mockdb.MockStore, fx fixture) {
				store.EXPECT().GetMedia(gomock.Any(), gomock.Eq(fx.media.ID)).Times(1).Return(db.Medium{}, sql.ErrNoRows)
				store.EXPECT().ReplaceMediaFile(gomock.Any(), gomock.Any()).Times(0)
			},
			check: func(t *testing.T, server *Server, recorder *httptest.ResponseRecorder, fx fixture) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
				require.Equal(t, []string{"hero.png"}, uploadedFiles(t, server))
			},
		},
		{
			// Seeded/legacy rows may point outside the upload dir: the new
			// file is stored as a fresh upload and the old path is untouched.
			name:     "PathOutsideUploadDirStoredAsNewFile",
			caller:   &editor,
			filename: "fresh.png",
			content:  func(t *testing.T) []byte { return testPNG(t, 6, 1) },
			buildStubs: func(t *testing.T, server *Server, store *mockdb.MockStore, fx fixture) {
				outside := filepath.Join(t.TempDir(), "legacy.png")
				require.NoError(t, os.WriteFile(outside, fx.original, 0644))
				legacy := fx.media
				legacy.MediaPath = outside

				store.EXPECT().GetMedia(gomock.Any(), gomock.Eq(fx.media.ID)).Times(1).Return(legacy, nil)
				store.EXPECT().ReplaceMediaFile(gomock.Any(), gomock.Any()).Times(1).
					DoAndReturn(func(ctx any, arg db.ReplaceMediaFileParams) (db.Medium, error) {
						require.Equal(t, server.config.UploadPath+"/fresh.png", arg.MediaPath)
						require.Equal(t, int32(6), arg.Width)
						t.Cleanup(func() {
							stored, err := os.ReadFile(outside)
							require.NoError(t, err)
							require.Equal(t, fx.original, stored, "file outside the upload dir is left alone")
						})
						return echoReplace(legacy)(ctx, arg)
					})
			},
			check: func(t *testing.T, server *Server, recorder *httptest.ResponseRecorder, fx fixture) {
				require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
				require.ElementsMatch(t, []string{"hero.png", "fresh.png"}, uploadedFiles(t, server))
			},
		},
		{
			// The route admits contributors (#135); ownership refuses others' media.
			name:     "ContributorForbiddenOnOthersMedia",
			caller:   &contributor,
			filename: "new.png",
			content:  func(t *testing.T) []byte { return testPNG(t, 2, 2) },
			buildStubs: func(t *testing.T, server *Server, store *mockdb.MockStore, fx fixture) {
				store.EXPECT().GetMedia(gomock.Any(), gomock.Any()).Times(1).Return(db.Medium{ID: 701, UserID: contributor.ID + 1}, nil)
				store.EXPECT().ReplaceMediaFile(gomock.Any(), gomock.Any()).Times(0)
			},
			check: func(t *testing.T, server *Server, recorder *httptest.ResponseRecorder, fx fixture) {
				require.Equal(t, http.StatusForbidden, recorder.Code)
			},
		},
		{
			name:     "NoAuthorization",
			filename: "new.png",
			content:  func(t *testing.T) []byte { return testPNG(t, 2, 2) },
			buildStubs: func(t *testing.T, server *Server, store *mockdb.MockStore, fx fixture) {
				store.EXPECT().ReplaceMediaFile(gomock.Any(), gomock.Any()).Times(0)
			},
			check: func(t *testing.T, server *Server, recorder *httptest.ResponseRecorder, fx fixture) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()
			store := mockdb.NewMockStore(ctrl)
			// 1KB so OverLimit stays small; the other uploads are tiny images.
			server := newTestServerWithMaxUpload(t, store, "1KB")

			media, original := replaceFixture(t, server, ownerID)
			fx := fixture{media: media, original: original}
			tc.buildStubs(t, server, store, fx)
			if tc.caller != nil {
				stubRoleLookup(store, *tc.caller)
			}

			mediaID := tc.mediaID
			if mediaID == "" {
				mediaID = fmt.Sprint(media.ID)
			}
			request := fileUploadRequest(t, "/api/v1/media/"+mediaID+"/replace", tc.filename, tc.content(t))
			if tc.caller != nil {
				addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, tc.caller.ID, tc.caller.Username, time.Minute)
			}

			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, request)
			tc.check(t, server, recorder, fx)
		})
	}
}

// TestReplaceMediaOwnerScopedRole mounts the handler without
// requireContentEditor (as TestMediaWriteOwnerScopedRole does for PUT and
// DELETE) to pin the ownership rule for roles admitted later.
func TestReplaceMediaOwnerScopedRole(t *testing.T) {
	contributor := db.User{ID: 9701, Username: "contributor", Role: RoleContributor}

	testCases := []struct {
		name     string
		ownerID  int64
		wantCode int
	}{
		{name: "OwnMedia", ownerID: contributor.ID, wantCode: http.StatusOK},
		{name: "OthersMediaForbidden", ownerID: 9702, wantCode: http.StatusForbidden},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()
			store := mockdb.NewMockStore(ctrl)
			server := newTestServer(t, store)
			server.router.POST("/owner-scoped/media/:id/replace", authMiddleware(server.tokenMaker, server.store), server.replaceMedia)

			media, original := replaceFixture(t, server, tc.ownerID)
			store.EXPECT().GetMedia(gomock.Any(), gomock.Eq(media.ID)).Times(1).Return(media, nil)
			replaces := 0
			if tc.wantCode == http.StatusOK {
				replaces = 1
			}
			store.EXPECT().ReplaceMediaFile(gomock.Any(), gomock.Any()).Times(replaces).DoAndReturn(echoReplace(media))
			stubRoleLookup(store, contributor)

			request := fileUploadRequest(t, fmt.Sprintf("/owner-scoped/media/%d/replace", media.ID), "new.png", testPNG(t, 3, 3))
			addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, contributor.ID, contributor.Username, time.Minute)

			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, request)
			require.Equal(t, tc.wantCode, recorder.Code, recorder.Body.String())

			if tc.wantCode != http.StatusOK {
				stored, err := os.ReadFile(media.MediaPath)
				require.NoError(t, err)
				require.Equal(t, original, stored)
			}
		})
	}
}

// TestSwapInFileWithoutOriginal covers replacing a row whose file is
// already gone: the new file lands, and rollback removes it again.
func TestSwapInFileWithoutOriginal(t *testing.T) {
	target := filepath.Join(t.TempDir(), "missing.png")

	swap, err := swapInFile(target, bytes.NewReader([]byte("new")))
	require.NoError(t, err)
	stored, err := os.ReadFile(target)
	require.NoError(t, err)
	require.Equal(t, "new", string(stored))

	require.NoError(t, swap.rollback())
	_, err = os.Stat(target)
	require.True(t, os.IsNotExist(err))
}

// Replace keeps the URL, so /uploads must make browsers revalidate.
func TestUploadsAreServedNoCache(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	server := newTestServer(t, mockdb.NewMockStore(ctrl))
	require.NoError(t, os.WriteFile(filepath.Join(server.config.UploadPath, "pic.png"), testPNG(t, 1, 1), 0644))

	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/uploads/media/pic.png", nil))
	require.Equal(t, http.StatusOK, recorder.Code)
	require.Equal(t, "no-cache", recorder.Header().Get("Cache-Control"))
	require.NotEmpty(t, recorder.Header().Get("Last-Modified"), "revalidation needs a validator")
}
