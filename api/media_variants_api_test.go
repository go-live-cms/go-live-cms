package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
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
	"github.com/sqlc-dev/pqtype"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// variantsFixture stores a 2000×1000 JPEG as hero.jpg with its variants in
// place, as an upload would have left it.
func variantsFixture(t *testing.T, server *Server, ownerID int64) db.Medium {
	t.Helper()
	path := filepath.Join(server.config.UploadPath, "hero.jpg")
	require.NoError(t, os.WriteFile(path, testJPEG(t, 2000, 1000), 0644))
	staged, err := stageImageVariants(server.config.UploadPath, path)
	require.NoError(t, err)
	require.NoError(t, staged.commit())
	return db.Medium{
		ID: 801, Name: "Hero", Description: "Homepage hero", Alt: "Hero",
		MediaPath: path, UserID: ownerID, MimeType: "image/jpeg",
		Width: 2000, Height: 1000, OriginalFilename: "hero.jpg",
		Variants:  staged.column().RawMessage,
		CreatedAt: time.Now().Add(-time.Hour), ChangedAt: time.Now().Add(-time.Hour),
	}
}

// createMediaRequest is a POST /media with the required form fields.
func createMediaRequest(t *testing.T, filename string, content []byte) *http.Request {
	t.Helper()
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	for k, v := range map[string]string{"name": "Photo", "description": "A test photo", "alt": "A photo"} {
		require.NoError(t, writer.WriteField(k, v))
	}
	part, err := writer.CreateFormFile("file", filename)
	require.NoError(t, err)
	_, err = part.Write(content)
	require.NoError(t, err)
	require.NoError(t, writer.Close())
	request, err := http.NewRequest(http.MethodPost, "/api/v1/media", body)
	require.NoError(t, err)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	return request
}

func echoReplaceWithVariants(media db.Medium) func(any, db.ReplaceMediaFileParams) (db.Medium, error) {
	return func(ctx any, arg db.ReplaceMediaFileParams) (db.Medium, error) {
		out, err := echoReplace(media)(ctx, arg)
		out.Variants = json.RawMessage(`{}`)
		if arg.Variants.Valid {
			out.Variants = arg.Variants.RawMessage
		}
		return out, err
	}
}

func TestReplaceMediaRegeneratesVariants(t *testing.T) {
	editor := db.User{ID: 9801, Username: "editor", Role: RoleEditor}

	t.Run("NewSizesReplaceOldOnes", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		server := newTestServerWithMaxUpload(t, store, "10MB")
		media := variantsFixture(t, server, editor.ID)
		stubRoleLookup(store, editor)

		store.EXPECT().GetMedia(gomock.Any(), media.ID).Return(media, nil)
		store.EXPECT().ReplaceMediaFile(gomock.Any(), gomock.Any()).
			DoAndReturn(func(ctx any, arg db.ReplaceMediaFileParams) (db.Medium, error) {
				// 600×300: only a thumb; medium and large must go.
				v := parseMediaVariants(arg.Variants.RawMessage)
				require.Len(t, v, 1)
				require.Equal(t, int32(320), v["thumb"].Width)
				require.Equal(t, int32(160), v["thumb"].Height)
				return echoReplaceWithVariants(media)(ctx, arg)
			})

		request := fileUploadRequest(t, fmt.Sprintf("/api/v1/media/%d/replace", media.ID), "new.jpg", testJPEG(t, 600, 300))
		addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, editor.ID, editor.Username, time.Minute)
		recorder := httptest.NewRecorder()
		server.router.ServeHTTP(recorder, request)
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())

		var rsp struct{ Media MediaResponse }
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
		require.Len(t, rsp.Media.Variants, 1)
		require.Equal(t, publicMediaPath(server.config.UploadPath, filepath.Dir(media.MediaPath)+"/_variants/hero.jpg/thumb.jpg"), rsp.Media.Variants["thumb"].Path,
			"variant URLs stay stable across a replace")
		require.True(t, strings.HasPrefix(rsp.Media.Variants["thumb"].Path, "/uploads/"), "responses carry the public URL path, not the stored filesystem path")

		w, h, _ := decodedSize(t, variantFile(media.MediaPath, "thumb.jpg"))
		require.Equal(t, [2]int{320, 160}, [2]int{w, h})
		for _, gone := range []string{"medium.jpg", "large.jpg"} {
			_, err := os.Stat(variantFile(media.MediaPath, gone))
			require.True(t, os.IsNotExist(err), gone)
		}
		entries, err := os.ReadDir(filepath.Join(server.config.UploadPath, variantsDirName))
		require.NoError(t, err)
		require.Len(t, entries, 1, "no staging directory left behind")
	})

	t.Run("FailedUpdateKeepsOldVariants", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		server := newTestServerWithMaxUpload(t, store, "10MB")
		media := variantsFixture(t, server, editor.ID)
		stubRoleLookup(store, editor)
		before, err := os.ReadFile(variantFile(media.MediaPath, "large.jpg"))
		require.NoError(t, err)

		store.EXPECT().GetMedia(gomock.Any(), media.ID).Return(media, nil)
		store.EXPECT().ReplaceMediaFile(gomock.Any(), gomock.Any()).Return(db.Medium{}, sql.ErrConnDone)

		request := fileUploadRequest(t, fmt.Sprintf("/api/v1/media/%d/replace", media.ID), "new.jpg", testJPEG(t, 600, 300))
		addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, editor.ID, editor.Username, time.Minute)
		recorder := httptest.NewRecorder()
		server.router.ServeHTTP(recorder, request)
		require.Equal(t, http.StatusInternalServerError, recorder.Code)

		after, err := os.ReadFile(variantFile(media.MediaPath, "large.jpg"))
		require.NoError(t, err)
		require.Equal(t, before, after)
		entries, err := os.ReadDir(filepath.Join(server.config.UploadPath, variantsDirName))
		require.NoError(t, err)
		require.Len(t, entries, 1, "staged variants discarded")
	})
}

func TestDeleteMediaRemovesVariants(t *testing.T) {
	editor := db.User{ID: 9811, Username: "editor", Role: RoleEditor}
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	server := newTestServerWithMaxUpload(t, store, "10MB")
	media := variantsFixture(t, server, editor.ID)
	stubRoleLookup(store, editor)

	store.EXPECT().GetMedia(gomock.Any(), media.ID).Return(media, nil)
	store.EXPECT().DeleteMediaTx(gomock.Any(), gomock.Any()).Return(nil)

	request, err := http.NewRequest(http.MethodDelete, fmt.Sprintf("/api/v1/media/%d", media.ID), nil)
	require.NoError(t, err)
	addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, editor.ID, editor.Username, time.Minute)
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())

	_, err = os.Stat(media.MediaPath)
	require.True(t, os.IsNotExist(err))
	_, err = os.Stat(variantDirFor(media.MediaPath))
	require.True(t, os.IsNotExist(err), "variants are deleted with the original")
}

func TestCreateMediaGeneratesVariants(t *testing.T) {
	editor := db.User{ID: 9821, Username: "editor", Role: RoleEditor}
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	server := newTestServerWithMaxUpload(t, store, "10MB")
	stubRoleLookup(store, editor)

	jpg := jpegWithEXIF(t, testJPEG(t, 1000, 800), 1)
	store.EXPECT().CreateMedia(gomock.Any(), gomock.Any()).
		DoAndReturn(func(_ context.Context, arg db.CreateMediaParams) (db.Medium, error) {
			v := parseMediaVariants(arg.Variants.RawMessage)
			require.Len(t, v, 2)
			require.Equal(t, int32(800), v["medium"].Width)
			require.Equal(t, int32(640), v["medium"].Height)
			stored, err := os.ReadFile(arg.MediaPath)
			require.NoError(t, err)
			require.Equal(t, int64(len(stored)), arg.FileSize, "size after stripping")
			require.NotContains(t, string(stored), "GPS")
			return db.Medium{ID: 9, MediaPath: arg.MediaPath, MimeType: arg.MimeType, Variants: arg.Variants.RawMessage}, nil
		})

	request := createMediaRequest(t, "trip.jpg", jpg)
	addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, editor.ID, editor.Username, time.Minute)
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())

	var rsp struct{ Media MediaResponse }
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
	require.Contains(t, rsp.Media.Variants, "thumb")
	require.Nil(t, rsp.Media.FocalPoint)
}

func TestFocalPointUpdate(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		wantSet bool
		want    *FocalPoint
		wantErr bool
	}{
		{name: "Absent", body: ``},
		{name: "Null", body: `null`, wantSet: true},
		{name: "Valid", body: `{"x":0.25,"y":1}`, wantSet: true, want: &FocalPoint{X: 0.25, Y: 1}},
		{name: "Corners", body: `{"x":0,"y":0}`, wantSet: true, want: &FocalPoint{}},
		{name: "OutOfRange", body: `{"x":1.5,"y":0.5}`, wantErr: true},
		{name: "Negative", body: `{"x":0.5,"y":-0.1}`, wantErr: true},
		{name: "MissingY", body: `{"x":0.5}`, wantErr: true},
		{name: "String", body: `{"x":"0.5","y":0.5}`, wantErr: true},
		{name: "NotObject", body: `[0.5,0.5]`, wantErr: true},
		{name: "UnknownField", body: `{"x":0.5,"y":0.5,"z":1}`, wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := UpdateMediaRequest{FocalPoint: json.RawMessage(tc.body)}
			set, point, err := req.focalPointUpdate()
			if tc.wantErr {
				require.ErrorIs(t, err, errInvalidFocalPoint)
				return
			}
			require.NoError(t, err)
			require.Equal(t, tc.wantSet, set)
			require.Equal(t, tc.want, point)
		})
	}
}

func TestUpdateMediaFocalPointAPI(t *testing.T) {
	editor := db.User{ID: 9831, Username: "editor", Role: RoleEditor}

	cases := []struct {
		name       string
		body       string
		buildStubs func(store *mockdb.MockStore)
		check      func(t *testing.T, recorder *httptest.ResponseRecorder)
	}{
		{
			name: "SetsFocalPoint",
			body: `{"focal_point":{"x":0.3,"y":0.7}}`,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().UpdateMediaMetadata(gomock.Any(), gomock.Eq(db.UpdateMediaMetadataParams{
					ID:            55,
					SetFocalPoint: true,
					FocalX:        sql.NullFloat64{Float64: 0.3, Valid: true},
					FocalY:        sql.NullFloat64{Float64: 0.7, Valid: true},
				})).Return(db.Medium{
					ID: 55, Variants: json.RawMessage(`{}`),
					FocalX: sql.NullFloat64{Float64: 0.3, Valid: true}, FocalY: sql.NullFloat64{Float64: 0.7, Valid: true},
				}, nil)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
				require.Contains(t, recorder.Body.String(), `"focal_point":{"x":0.3,"y":0.7}`)
				require.Contains(t, recorder.Body.String(), `"variants":{}`)
			},
		},
		{
			name: "NullClears",
			body: `{"focal_point":null}`,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().UpdateMediaMetadata(gomock.Any(), gomock.Eq(db.UpdateMediaMetadataParams{ID: 55, SetFocalPoint: true})).
					Return(db.Medium{ID: 55}, nil)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
				require.Contains(t, recorder.Body.String(), `"focal_point":null`)
			},
		},
		{
			name: "AbsentKeeps",
			body: `{"alt":"New alt"}`,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().UpdateMediaMetadata(gomock.Any(), gomock.Eq(db.UpdateMediaMetadataParams{
					ID: 55, Alt: sql.NullString{String: "New alt", Valid: true},
				})).Return(db.Medium{ID: 55}, nil)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
			},
		},
		{
			name: "OutOfRangeRejected",
			body: `{"focal_point":{"x":2,"y":0.5}}`,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().UpdateMediaMetadata(gomock.Any(), gomock.Any()).Times(0)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
				require.Contains(t, recorder.Body.String(), "focal_point must be")
			},
		},
		{
			name: "VariantsAreServerOwned",
			body: `{"variants":{"thumb":{"path":"/etc/passwd"}}}`,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().UpdateMediaMetadata(gomock.Any(), gomock.Any()).Times(0)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
				require.Contains(t, recorder.Body.String(), "variants cannot be updated")
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			server := newTestServer(t, store)
			stubRoleLookup(store, editor)
			tc.buildStubs(store)

			request, err := http.NewRequest(http.MethodPut, "/api/v1/media/55", bytes.NewBufferString(tc.body))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")
			addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, editor.ID, editor.Username, time.Minute)
			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, request)
			tc.check(t, recorder)
		})
	}
}

func TestAttachBlockMedia(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	server := newTestServer(t, store)

	var docA, docB map[string]interface{}
	require.NoError(t, json.Unmarshal([]byte(`{"doc_version":1,"blocks_order":["a","b","c"],"blocks":{
		"a":{"id":"a","type":"image","attrs":{"src":"/uploads/x.jpg","mediaId":12}},
		"b":{"id":"b","type":"paragraph","attrs":{"mediaId":99}},
		"c":{"id":"c","type":"image","attrs":{"src":"/uploads/gone.jpg","mediaId":404}}}}`), &docA))
	require.NoError(t, json.Unmarshal([]byte(`{"doc_version":1,"blocks_order":["d"],"blocks":{
		"d":{"id":"d","type":"image","attrs":{"src":"/uploads/x.jpg","mediaId":"12"}}}}`), &docB))
	noImages := map[string]interface{}{"blocks": map[string]interface{}{}}

	store.EXPECT().GetMediaByIDs(gomock.Any(), gomock.Any()).Times(1).
		DoAndReturn(func(_ context.Context, ids []int64) ([]db.Medium, error) {
			require.ElementsMatch(t, []int64{12, 404}, ids, "one query, deduplicated, paragraphs ignored")
			return []db.Medium{{
				ID: 12, MediaPath: "/uploads/x.jpg", Width: 2000, Height: 1000,
				Variants: json.RawMessage(`{"thumb":{"path":"/uploads/_variants/x.jpg/thumb.jpg","width":320,"height":160}}`),
				FocalX:   sql.NullFloat64{Float64: 0.2, Valid: true}, FocalY: sql.NullFloat64{Float64: 0.8, Valid: true},
			}}, nil
		})

	server.attachBlockMedia(context.Background(), docA, docB, noImages, nil)

	for _, doc := range []map[string]interface{}{docA, docB} {
		media := doc["media"].(map[string]BlockMedia)
		require.Len(t, media, 1, "missing media is left out")
		require.Equal(t, int32(2000), media["12"].Width)
		require.Equal(t, &FocalPoint{X: 0.2, Y: 0.8}, media["12"].FocalPoint)
		require.Equal(t, int32(320), media["12"].Variants["thumb"].Width)
	}
	require.NotContains(t, noImages, "media")

	// No image blocks: no query at all.
	server.attachBlockMedia(context.Background(), noImages)
}

// A nil staged set (file outside UploadPath) stores no variants.
func TestNilStagedVariantsColumnIsNull(t *testing.T) {
	var staged *stagedVariants
	require.Equal(t, pqtype.NullRawMessage{}, staged.column())
}
