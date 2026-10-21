package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
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

// bulkUploadRequest builds a multipart POST to url with one "files" part per
// entry of names, each holding a few bytes.
func bulkUploadRequest(t *testing.T, url string, names []string) *http.Request {
	t.Helper()

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	for _, name := range names {
		part, err := writer.CreateFormFile("files", name)
		require.NoError(t, err)
		_, err = part.Write([]byte("content of " + name))
		require.NoError(t, err)
	}
	require.NoError(t, writer.Close())

	request, err := http.NewRequest(http.MethodPost, url, body)
	require.NoError(t, err)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	return request
}

// bulkUploadResponse mirrors createMediaBulk's body.
type bulkUploadResponse struct {
	Success []MediaResponse `json:"success"`
	Errors  []string        `json:"errors"`
	Meta    struct {
		Total      int `json:"total"`
		Successful int `json:"successful"`
		Failed     int `json:"failed"`
	} `json:"meta"`
}

// uploadedFiles lists the files in the server's upload directory.
func uploadedFiles(t *testing.T, server *Server) []string {
	t.Helper()
	entries, err := os.ReadDir(server.config.UploadPath)
	require.NoError(t, err)
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

func TestCreateMediaBulkAPI(t *testing.T) {
	editor := db.User{ID: 9301, Username: "editor", Role: RoleEditor}
	contributor := db.User{ID: 9302, Username: "contributor", Role: RoleContributor}

	// echoCreate returns the row the handler asked for, like the real insert.
	echoCreate := func(_ any, arg db.CreateMediaParams) (db.Medium, error) {
		return db.Medium{
			ID:               int64(len(arg.OriginalFilename)),
			Name:             arg.Name,
			Description:      arg.Description,
			Alt:              arg.Alt,
			MediaPath:        arg.MediaPath,
			UserID:           arg.UserID,
			FileSize:         arg.FileSize,
			MimeType:         arg.MimeType,
			OriginalFilename: arg.OriginalFilename,
			CreatedAt:        time.Now(),
			ChangedAt:        time.Now(),
		}, nil
	}

	testCases := []struct {
		name          string
		caller        *db.User
		files         []string
		buildStubs    func(t *testing.T, server *Server, store *mockdb.MockStore)
		checkResponse func(t *testing.T, server *Server, recorder *httptest.ResponseRecorder)
	}{
		{
			// One bad file doesn't sink the batch; it's reported per file.
			name:   "PartialSuccess",
			caller: &editor,
			files:  []string{"photo.png", "payload.exe", "notes.txt"},
			buildStubs: func(t *testing.T, server *Server, store *mockdb.MockStore) {
				store.EXPECT().
					CreateMedia(gomock.Any(), gomock.Any()).
					Times(2).
					DoAndReturn(func(ctx any, arg db.CreateMediaParams) (db.Medium, error) {
						// Owner comes from the token, never the form.
						require.Equal(t, editor.ID, arg.UserID)
						require.True(t, strings.HasPrefix(arg.MediaPath, server.config.UploadPath+"/"), arg.MediaPath)
						return echoCreate(ctx, arg)
					})
			},
			checkResponse: func(t *testing.T, server *Server, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())

				var rsp bulkUploadResponse
				require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
				require.Equal(t, 3, rsp.Meta.Total)
				require.Equal(t, 2, rsp.Meta.Successful)
				require.Equal(t, 1, rsp.Meta.Failed)
				require.Len(t, rsp.Success, 2)
				require.Equal(t, []string{"invalid file type for payload.exe"}, rsp.Errors)
				require.ElementsMatch(t, []string{"photo.png", "notes.txt"}, uploadedFiles(t, server))
			},
		},
		{
			// The multipart filename is reduced to its base name and cleaned,
			// so it can't climb out of the upload directory.
			name:   "PathTraversalFilenameStaysInUploadDir",
			caller: &editor,
			files:  []string{"../../escape.png"},
			buildStubs: func(t *testing.T, server *Server, store *mockdb.MockStore) {
				store.EXPECT().CreateMedia(gomock.Any(), gomock.Any()).Times(1).DoAndReturn(echoCreate)
			},
			checkResponse: func(t *testing.T, server *Server, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
				require.Equal(t, []string{"escape.png"}, uploadedFiles(t, server))
				_, err := os.Stat(filepath.Join(server.config.UploadPath, "..", "..", "escape.png"))
				require.True(t, os.IsNotExist(err))
			},
		},
		{
			// A failed insert must not leave an orphaned file behind.
			name:   "StoreErrorRemovesFile",
			caller: &editor,
			files:  []string{"photo.png"},
			buildStubs: func(t *testing.T, server *Server, store *mockdb.MockStore) {
				store.EXPECT().CreateMedia(gomock.Any(), gomock.Any()).Times(1).Return(db.Medium{}, errors.New("insert failed"))
			},
			checkResponse: func(t *testing.T, server *Server, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusCreated, recorder.Code)

				var rsp bulkUploadResponse
				require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
				require.Equal(t, 0, rsp.Meta.Successful)
				require.Equal(t, 1, rsp.Meta.Failed)
				require.Empty(t, uploadedFiles(t, server))
			},
		},
		{
			name:   "NoFiles",
			caller: &editor,
			files:  nil,
			buildStubs: func(t *testing.T, server *Server, store *mockdb.MockStore) {
				store.EXPECT().CreateMedia(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, server *Server, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
				require.Contains(t, recorder.Body.String(), "no files provided")
			},
		},
		{
			name:   "TooManyFiles",
			caller: &editor,
			files: func() []string {
				names := make([]string, 21)
				for i := range names {
					names[i] = fmt.Sprintf("img%d.png", i)
				}
				return names
			}(),
			buildStubs: func(t *testing.T, server *Server, store *mockdb.MockStore) {
				store.EXPECT().CreateMedia(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, server *Server, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
				require.Contains(t, recorder.Body.String(), "too many files")
				require.Empty(t, uploadedFiles(t, server))
			},
		},
		{
			name:   "ContributorForbidden",
			caller: &contributor,
			files:  []string{"photo.png"},
			buildStubs: func(t *testing.T, server *Server, store *mockdb.MockStore) {
				store.EXPECT().CreateMedia(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, server *Server, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusForbidden, recorder.Code)
				require.Empty(t, uploadedFiles(t, server))
			},
		},
		{
			name:  "NoAuthorization",
			files: []string{"photo.png"},
			buildStubs: func(t *testing.T, server *Server, store *mockdb.MockStore) {
				store.EXPECT().CreateMedia(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, server *Server, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
	}

	for i := range testCases {
		tc := testCases[i]

		// /media/bulk is an alias of /media/batch; both must enforce the same rules.
		for _, path := range []string{"/api/v1/media/batch", "/api/v1/media/bulk"} {
			t.Run(tc.name+path[len("/api/v1/media"):], func(t *testing.T) {
				ctrl := gomock.NewController(t)
				defer ctrl.Finish()

				store := mockdb.NewMockStore(ctrl)
				server := newTestServer(t, store)
				tc.buildStubs(t, server, store)
				if tc.caller != nil {
					stubRoleLookup(store, *tc.caller)
				}

				request := bulkUploadRequest(t, path, tc.files)
				if tc.caller != nil {
					addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, tc.caller.ID, tc.caller.Username, time.Minute)
				}

				recorder := httptest.NewRecorder()
				server.router.ServeHTTP(recorder, request)
				tc.checkResponse(t, server, recorder)
			})
		}
	}
}

func TestGetMediaPostsAPI(t *testing.T) {
	media := randomMedia()
	posts := []db.GetPostsByMediaRow{
		{ID: 11, Title: "First", Username: "alice", PostType: "post", PostStatus: "published", MediaOrder: 0, RelationshipType: "attachment", PostParent: sql.NullInt64{Int64: 3, Valid: true}},
		{ID: 12, Title: "Second", Username: "bob", PostType: "page", PostStatus: "draft", MediaOrder: 1, RelationshipType: "gallery"},
	}

	testCases := []struct {
		name          string
		mediaID       string
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(t *testing.T, recorder *httptest.ResponseRecorder)
	}{
		{
			name:    "OK",
			mediaID: fmt.Sprint(media.ID),
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetMedia(gomock.Any(), gomock.Eq(media.ID)).Times(1).Return(media, nil)
				store.EXPECT().GetPostsByMedia(gomock.Any(), gomock.Eq(media.ID)).Times(1).Return(posts, nil)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)

				var rsp struct {
					Media MediaResponse                `json:"media"`
					Posts []PostWithMediaOrderResponse `json:"posts"`
					Meta  struct {
						MediaID int64 `json:"media_id"`
						Count   int   `json:"count"`
					} `json:"meta"`
				}
				require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
				require.Equal(t, media.ID, rsp.Media.ID)
				require.Equal(t, media.ID, rsp.Meta.MediaID)
				require.Equal(t, 2, rsp.Meta.Count)
				require.Len(t, rsp.Posts, 2)
				require.Equal(t, int64(11), rsp.Posts[0].Post.ID)
				require.Equal(t, "attachment", rsp.Posts[0].RelationshipType)
				require.NotNil(t, rsp.Posts[0].Post.PostParent)
				require.Equal(t, int64(3), *rsp.Posts[0].Post.PostParent)
				require.Nil(t, rsp.Posts[1].Post.PostParent)
				require.Equal(t, int32(1), rsp.Posts[1].MediaOrder)
			},
		},
		{
			name:    "NoPosts",
			mediaID: fmt.Sprint(media.ID),
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetMedia(gomock.Any(), gomock.Eq(media.ID)).Times(1).Return(media, nil)
				store.EXPECT().GetPostsByMedia(gomock.Any(), gomock.Eq(media.ID)).Times(1).Return(nil, nil)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				require.Contains(t, recorder.Body.String(), `"posts":[]`)
			},
		},
		{
			name:    "InvalidID",
			mediaID: "abc",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetMedia(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name:    "MediaNotFound",
			mediaID: fmt.Sprint(media.ID),
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetMedia(gomock.Any(), gomock.Eq(media.ID)).Times(1).Return(db.Medium{}, sql.ErrNoRows)
				store.EXPECT().GetPostsByMedia(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:    "MediaLookupFails",
			mediaID: fmt.Sprint(media.ID),
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetMedia(gomock.Any(), gomock.Eq(media.ID)).Times(1).Return(db.Medium{}, sql.ErrConnDone)
				store.EXPECT().GetPostsByMedia(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
		{
			name:    "PostsLookupFails",
			mediaID: fmt.Sprint(media.ID),
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetMedia(gomock.Any(), gomock.Eq(media.ID)).Times(1).Return(media, nil)
				store.EXPECT().GetPostsByMedia(gomock.Any(), gomock.Eq(media.ID)).Times(1).Return(nil, sql.ErrConnDone)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
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
			request, err := http.NewRequest(http.MethodGet, "/api/v1/media/"+tc.mediaID+"/posts", nil)
			require.NoError(t, err)

			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(t, recorder)
		})
	}
}

// TestUpdateMediaServerOwnedFields pins which request fields are refused, so
// adding a file column to UpdateMediaRequest without listing it here fails.
func TestUpdateMediaServerOwnedFields(t *testing.T) {
	testCases := []struct {
		name string
		body string
		want []string
	}{
		{"MetadataOnly", `{"name":"ok","alt":"fine"}`, nil},
		{"NullsAreUnset", `{"media_path":null,"file_size":null,"mime_type":null,"width":null,"height":null,"duration":null,"original_filename":null}`, nil},
		{"MediaPath", `{"media_path":"/etc/passwd"}`, []string{"media_path"}},
		{"EmptyStringIsSet", `{"original_filename":""}`, []string{"original_filename"}},
		{"ZeroIsSet", `{"width":0}`, []string{"width"}},
		{
			"AllInStableOrder",
			`{"original_filename":"x","duration":1,"height":1,"width":1,"mime_type":"x","file_size":1,"media_path":"x"}`,
			[]string{"media_path", "file_size", "mime_type", "width", "height", "duration", "original_filename"},
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			var req UpdateMediaRequest
			require.NoError(t, json.Unmarshal([]byte(tc.body), &req))
			require.Equal(t, tc.want, req.serverOwnedFields())
		})
	}
}

// TestUpdateMediaRequestErrors covers PUT /media/:id failures decided before
// or around the ownership check.
func TestUpdateMediaRequestErrors(t *testing.T) {
	editor := db.User{ID: 9401, Username: "editor", Role: RoleEditor}
	contributor := db.User{ID: 9402, Username: "contributor", Role: RoleContributor}

	testCases := []struct {
		name       string
		caller     db.User
		mediaID    string
		body       string
		buildStubs func(store *mockdb.MockStore)
		wantCode   int
	}{
		{
			name:    "InvalidID",
			caller:  editor,
			mediaID: "abc",
			body:    `{"name":"renamed"}`,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().UpdateMediaMetadata(gomock.Any(), gomock.Any()).Times(0)
			},
			wantCode: http.StatusBadRequest,
		},
		{
			name:    "MalformedJSON",
			caller:  editor,
			mediaID: "5",
			body:    `{"name":`,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().UpdateMediaMetadata(gomock.Any(), gomock.Any()).Times(0)
			},
			wantCode: http.StatusBadRequest,
		},
		{
			name:    "NameTooShort",
			caller:  editor,
			mediaID: "5",
			body:    `{"name":"x"}`,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().UpdateMediaMetadata(gomock.Any(), gomock.Any()).Times(0)
			},
			wantCode: http.StatusBadRequest,
		},
		{
			name:    "UpdateFails",
			caller:  editor,
			mediaID: "5",
			body:    `{"name":"renamed"}`,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().UpdateMediaMetadata(gomock.Any(), gomock.Any()).Times(1).Return(db.Medium{}, sql.ErrConnDone)
			},
			wantCode: http.StatusInternalServerError,
		},
		{
			// Owner-scoped caller: the ownership read fails, so nothing is written.
			name:    "OwnerScopedMediaNotFound",
			caller:  contributor,
			mediaID: "5",
			body:    `{"name":"renamed"}`,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetMedia(gomock.Any(), gomock.Eq(int64(5))).Times(1).Return(db.Medium{}, sql.ErrNoRows)
				store.EXPECT().UpdateMediaMetadata(gomock.Any(), gomock.Any()).Times(0)
			},
			wantCode: http.StatusNotFound,
		},
		{
			name:    "OwnerScopedLookupFails",
			caller:  contributor,
			mediaID: "5",
			body:    `{"name":"renamed"}`,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetMedia(gomock.Any(), gomock.Eq(int64(5))).Times(1).Return(db.Medium{}, sql.ErrConnDone)
				store.EXPECT().UpdateMediaMetadata(gomock.Any(), gomock.Any()).Times(0)
			},
			wantCode: http.StatusInternalServerError,
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

			// Mounted behind authMiddleware only, as in
			// TestMediaWriteOwnerScopedRole, so the contributor reaches the
			// owner-scoped branch.
			server := newTestServer(t, store)
			server.router.PUT("/owner-scoped/media/:id", authMiddleware(server.tokenMaker, server.store), server.updateMedia)

			request, err := http.NewRequest(http.MethodPut, "/owner-scoped/media/"+tc.mediaID, strings.NewReader(tc.body))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")
			addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, tc.caller.ID, tc.caller.Username, time.Minute)

			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, request)
			require.Equal(t, tc.wantCode, recorder.Code, recorder.Body.String())
		})
	}
}
