package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// A video's captions (#507): the .vtt upload, how /uploads serves it, PUT /media/:id's
// captions, the public block media entry and "Used in" for the captions file.

func TestIsWebVTT(t *testing.T) {
	ok := []string{
		"WEBVTT\n\n00:00.000 --> 00:01.000\nHello",
		"WEBVTT\r\n\r\n00:00.000 --> 00:01.000\nHello",
		"WEBVTT\r00:00.000 --> 00:01.000",
		"WEBVTT - Studio tour\n",
		"WEBVTT\tKind: captions\n",
		"\xEF\xBB\xBFWEBVTT\n",
	}
	for _, content := range ok {
		require.True(t, isWebVTT([]byte(content)), "%q", content)
	}
	refused := []string{
		"",
		"WEBVTT",                           // nothing after the signature
		"WEBVTTX\n",                        // not followed by a space, tab or line break
		"webvtt\n",                         // the signature is case-sensitive
		" WEBVTT\n",                        // nothing before it but a BOM
		"\xEF\xBB\xBF\xEF\xBB\xBFWEBVTT\n", // one BOM only
		"<!DOCTYPE html><html><body>WEBVTT\n</body></html>",
		"<html><script>alert(1)</script></html>",
		"1\n00:00:00,000 --> 00:00:01,000\nAn SRT file\n",
		"WEBVTT\n\x00\x01\x02\x03\x04\x05\x06\x07\x08", // binary after the header
	}
	for _, content := range refused {
		require.False(t, isWebVTT([]byte(content)), "%q", content)
	}
}

func TestValidateMediaUploadWebVTT(t *testing.T) {
	cases := []struct {
		filename string
		content  string
		wantErr  error
	}{
		{"tour-en.vtt", "WEBVTT\n\n00:00.000 --> 00:02.000\nWelcome to the studio.\n", nil},
		{"TOUR.VTT", "\xEF\xBB\xBFWEBVTT\r\n", nil},
		{"page.vtt", "<!DOCTYPE html><html><script>alert(1)</script></html>", errMediaContentMismatch},
		{"subs.vtt", "1\n00:00:00,000 --> 00:00:01,000\nSRT\n", errMediaContentMismatch},
		{"empty.vtt", "", errMediaContentMismatch},
		// A WebVTT file under another extension is that extension's type, not captions.
		{"tour.txt", "WEBVTT\n", nil},
	}
	for _, tc := range cases {
		t.Run(tc.filename, func(t *testing.T) {
			request := fileUploadRequest(t, "/", tc.filename, []byte(tc.content))
			require.NoError(t, request.ParseMultipartForm(1<<20))
			file, header, err := request.FormFile("file")
			require.NoError(t, err)
			defer file.Close()
			mime, err := validateMediaUpload(file, header, 1<<20)
			if tc.wantErr != nil {
				require.ErrorIs(t, err, tc.wantErr)
				return
			}
			require.NoError(t, err)
			if filepath.Ext(tc.filename) == ".txt" {
				require.Equal(t, "text/plain", mime)
			} else {
				require.Equal(t, captionsMimeType, mime)
			}
		})
	}
	require.Equal(t, captionsMimeType, getMimeTypeFilter("captions"))
}

// /uploads serves a .vtt as text/vtt (a <track> refuses anything else), never sniffed;
// other files keep the file server's type.
func TestUploadsServeWebVTT(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	config := newTestConfig(t)
	config.UploadPath = filepath.Join(t.TempDir(), "media")
	require.NoError(t, os.MkdirAll(config.UploadPath, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(config.UploadPath, "tour-en-0a1b.vtt"), []byte("WEBVTT\n\n00:00.000 --> 00:01.000\n<b>Hi</b>\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(config.UploadPath, "notes.txt"), []byte("notes"), 0o644))
	server, err := NewServer(config, store)
	require.NoError(t, err)

	for _, path := range []string{"/uploads/media/tour-en-0a1b.vtt", "/uploads/media/notes.txt"} {
		recorder := httptest.NewRecorder()
		server.router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		require.Equal(t, http.StatusOK, recorder.Code, path)
		require.Equal(t, "nosniff", recorder.Header().Get("X-Content-Type-Options"), path)
		if filepath.Ext(path) == ".vtt" {
			require.Equal(t, "text/vtt; charset=utf-8", recorder.Header().Get("Content-Type"))
			require.Contains(t, recorder.Body.String(), "WEBVTT")
		} else {
			require.Equal(t, "text/plain; charset=utf-8", recorder.Header().Get("Content-Type"))
		}
	}
}

func putMediaJSON(t *testing.T, server *Server, user db.User, id int64, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPut, fmt.Sprintf("/api/v1/media/%d", id), bytes.NewReader([]byte(body)))
	request.Header.Set("Content-Type", "application/json")
	addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	return recorder
}

func TestUpdateMediaCaptions(t *testing.T) {
	editor := db.User{ID: 9507, Username: "editor", Role: RoleEditor}
	video := db.Medium{ID: 40, MimeType: "video/mp4", UserID: 1}
	captioned := db.Medium{ID: 40, MimeType: "video/mp4", UserID: 1, CaptionsMediaID: sql.NullInt64{Int64: 41, Valid: true}, CaptionsLang: "pt-BR"}
	vtt := db.Medium{ID: 41, MimeType: captionsMimeType, UserID: 2}

	testCases := []struct {
		name     string
		body     string
		stored   db.Medium
		target   *db.Medium // GetMedia(41)
		settings bool       // the site language is read
		want     *db.UpdateMediaMetadataParams
		status   int
		code     string
	}{
		{
			name:     "SetWithTheSiteLanguage",
			body:     `{"captions_media_id": 41}`,
			stored:   video,
			target:   &vtt,
			settings: true,
			want:     &db.UpdateMediaMetadataParams{ID: 40, SetCaptions: true, CaptionsMediaID: sql.NullInt64{Int64: 41, Valid: true}, CaptionsLang: sql.NullString{String: "pt-PT", Valid: true}},
			status:   http.StatusOK,
		},
		{
			name:   "SetWithALanguage",
			body:   `{"captions_media_id": 41, "captions_lang": " es "}`,
			stored: video,
			target: &vtt,
			want:   &db.UpdateMediaMetadataParams{ID: 40, SetCaptions: true, CaptionsMediaID: sql.NullInt64{Int64: 41, Valid: true}, CaptionsLang: sql.NullString{String: "es", Valid: true}},
			status: http.StatusOK,
		},
		{
			// Replacing the file keeps the stored language.
			name:   "ReplaceKeepsTheLanguage",
			body:   `{"captions_media_id": 41}`,
			stored: captioned,
			target: &vtt,
			want:   &db.UpdateMediaMetadataParams{ID: 40, SetCaptions: true, CaptionsMediaID: sql.NullInt64{Int64: 41, Valid: true}},
			status: http.StatusOK,
		},
		{
			name:   "Remove",
			body:   `{"captions_media_id": null}`,
			stored: captioned,
			want:   &db.UpdateMediaMetadataParams{ID: 40, SetCaptions: true, CaptionsLang: sql.NullString{String: "", Valid: true}},
			status: http.StatusOK,
		},
		{
			name:   "LanguageAlone",
			body:   `{"captions_lang": "en-GB"}`,
			stored: captioned,
			want:   &db.UpdateMediaMetadataParams{ID: 40, CaptionsLang: sql.NullString{String: "en-GB", Valid: true}},
			status: http.StatusOK,
		},
		{name: "LanguageWithoutCaptions", body: `{"captions_lang": "en"}`, stored: video, status: http.StatusBadRequest, code: "invalid_captions"},
		{name: "NotAVideo", body: `{"captions_media_id": 41}`, stored: db.Medium{ID: 40, MimeType: "image/png", UserID: 1}, status: http.StatusBadRequest, code: "captions_not_video"},
		{name: "NotWebVTT", body: `{"captions_media_id": 41}`, stored: video, target: &db.Medium{ID: 41, MimeType: "text/plain"}, status: http.StatusBadRequest, code: "invalid_captions"},
		{name: "NoSuchFile", body: `{"captions_media_id": 41}`, stored: video, target: &db.Medium{}, status: http.StatusBadRequest, code: "invalid_captions"},
		{name: "BadID", body: `{"captions_media_id": "41"}`, status: http.StatusBadRequest, code: "invalid_captions"},
		{name: "ZeroID", body: `{"captions_media_id": 0}`, status: http.StatusBadRequest, code: "invalid_captions"},
		{name: "BadLanguage", body: `{"captions_media_id": 41, "captions_lang": "en US"}`, status: http.StatusBadRequest, code: "invalid_captions_lang"},
		{name: "LanguageTooLong", body: `{"captions_lang": "en-aaaaaaaa-bbbbbbbb-cccccccc-dddddddd"}`, status: http.StatusBadRequest},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			stubRoleLookup(store, editor)
			if tc.stored.ID != 0 {
				store.EXPECT().GetMedia(gomock.Any(), int64(40)).Return(tc.stored, nil)
			}
			if tc.target != nil {
				if tc.target.ID == 0 {
					store.EXPECT().GetMedia(gomock.Any(), int64(41)).Return(db.Medium{}, sql.ErrNoRows)
				} else {
					store.EXPECT().GetMedia(gomock.Any(), int64(41)).Return(*tc.target, nil)
				}
			}
			if tc.settings {
				store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{SiteLanguage: "pt-PT"}, nil)
			}
			if tc.want != nil {
				store.EXPECT().UpdateMediaMetadata(gomock.Any(), gomock.Eq(*tc.want)).Return(db.Medium{ID: 40, MimeType: "video/mp4", CaptionsMediaID: tc.want.CaptionsMediaID, CaptionsLang: tc.want.CaptionsLang.String}, nil)
			} else {
				store.EXPECT().UpdateMediaMetadata(gomock.Any(), gomock.Any()).Times(0)
			}
			server := newTestServer(t, store)

			recorder := putMediaJSON(t, server, editor, 40, tc.body)
			require.Equal(t, tc.status, recorder.Code, recorder.Body.String())
			if tc.code != "" {
				require.Contains(t, recorder.Body.String(), fmt.Sprintf(`"code":"%s"`, tc.code))
			}
			if tc.status == http.StatusOK {
				var body struct {
					Media MediaResponse `json:"media"`
				}
				require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
				if tc.want.CaptionsMediaID.Valid {
					require.Equal(t, int64(41), *body.Media.CaptionsMediaID)
				} else {
					require.Nil(t, body.Media.CaptionsMediaID)
				}
			}
		})
	}
}

// The captions file deleted between the check and the update (the FK refuses it): a 400,
// not a 500.
func TestUpdateMediaCaptionsFileDeletedMeanwhile(t *testing.T) {
	editor := db.User{ID: 9507, Username: "editor", Role: RoleEditor}
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	stubRoleLookup(store, editor)
	store.EXPECT().GetMedia(gomock.Any(), int64(40)).Return(db.Medium{ID: 40, MimeType: "video/mp4", CaptionsLang: "en"}, nil)
	store.EXPECT().GetMedia(gomock.Any(), int64(41)).Return(db.Medium{ID: 41, MimeType: captionsMimeType}, nil)
	store.EXPECT().UpdateMediaMetadata(gomock.Any(), gomock.Any()).Return(db.Medium{}, errors.New(`pq: insert or update on table "media" violates foreign key constraint "media_captions_media_id_fkey"`))
	server := newTestServer(t, store)

	recorder := putMediaJSON(t, server, editor, 40, `{"captions_media_id": 41}`)
	require.Equal(t, http.StatusBadRequest, recorder.Code, recorder.Body.String())
	require.Contains(t, recorder.Body.String(), `"code":"invalid_captions"`)
}

// A contributor may caption their own video only (canWriteMedia, as for any edit).
func TestUpdateMediaCaptionsOwnership(t *testing.T) {
	contributor := db.User{ID: 9508, Username: "contributor", Role: RoleContributor}
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	stubRoleLookup(store, contributor)
	store.EXPECT().GetMedia(gomock.Any(), int64(40)).Return(db.Medium{ID: 40, MimeType: "video/mp4", UserID: 1}, nil)
	store.EXPECT().UpdateMediaMetadata(gomock.Any(), gomock.Any()).Times(0)
	server := newTestServer(t, store)

	recorder := putMediaJSON(t, server, contributor, 40, `{"captions_media_id": 41}`)
	require.Equal(t, http.StatusForbidden, recorder.Code, recorder.Body.String())
}

func TestAttachBlockMediaCaptions(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	server := newTestServer(t, store)
	server.config.UploadPath = "/app/uploads/media"

	var doc map[string]interface{}
	require.NoError(t, json.Unmarshal([]byte(`{"doc_version":1,"blocks_order":["video-0001","video-0002","audio-0001","file-00001"],"blocks":{
		"video-0001":{"id":"video-0001","type":"video","attrs":{"mediaId":12}},
		"video-0002":{"id":"video-0002","type":"video","attrs":{"mediaId":15}},
		"audio-0001":{"id":"audio-0001","type":"audio","attrs":{"mediaId":13}},
		"file-00001":{"id":"file-00001","type":"file","attrs":{"mediaId":16}}}}`), &doc))

	gomock.InOrder(
		store.EXPECT().GetMediaByIDs(gomock.Any(), gomock.Any()).
			DoAndReturn(func(_ context.Context, ids []int64) ([]db.Medium, error) {
				require.ElementsMatch(t, []int64{12, 15, 13, 16}, ids)
				return []db.Medium{
					{ID: 12, MediaPath: "/app/uploads/media/tour.mp4", MimeType: "video/mp4", Name: "Tour", CaptionsMediaID: sql.NullInt64{Int64: 30, Valid: true}, CaptionsLang: "en-US"},
					// Its captions file was replaced by something that isn't WebVTT: no track.
					{ID: 15, MediaPath: "/app/uploads/media/b.mp4", MimeType: "video/mp4", CaptionsMediaID: sql.NullInt64{Int64: 31, Valid: true}, CaptionsLang: "es"},
					// Audio and a file block showing a video: never captions.
					{ID: 13, MediaPath: "/app/uploads/media/a.mp3", MimeType: "audio/mpeg", CaptionsMediaID: sql.NullInt64{Int64: 30, Valid: true}},
					{ID: 16, MediaPath: "/app/uploads/media/c.mp4", MimeType: "video/mp4", CaptionsMediaID: sql.NullInt64{Int64: 32, Valid: true}},
				}, nil
			}),
		store.EXPECT().GetMediaByIDs(gomock.Any(), gomock.Any()).
			DoAndReturn(func(_ context.Context, ids []int64) ([]db.Medium, error) {
				require.ElementsMatch(t, []int64{30, 31}, ids, "only the videos a video block shows")
				return []db.Medium{
					{ID: 30, MediaPath: "/app/uploads/media/tour-en.vtt", MimeType: captionsMimeType, Name: " English "},
					{ID: 31, MediaPath: "/app/uploads/media/b.txt", MimeType: "text/plain", Name: "B"},
				}, nil
			}),
	)

	server.attachBlockMedia(context.Background(), doc)
	media := doc["media"].(map[string]BlockMedia)
	require.Equal(t, &BlockCaptions{URL: "/uploads/media/tour-en.vtt", Lang: "en-US", Label: "English"}, media["12"].Captions)
	require.Nil(t, media["15"].Captions)
	require.Nil(t, media["13"].Captions)
	require.Nil(t, media["16"].Captions)

	encoded, err := json.Marshal(doc)
	require.NoError(t, err)
	require.Contains(t, string(encoded), `"captions":{"url":"/uploads/media/tour-en.vtt","lang":"en-US","label":"English"}`)
	require.Equal(t, 1, bytes.Count(encoded, []byte(`"captions"`)))
}

// The captions lookup failing, or the captions file deleted, leaves the video without
// captions; the video still plays.
func TestAttachBlockMediaCaptionsMissing(t *testing.T) {
	for _, failed := range []bool{true, false} {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		server := newTestServer(t, store)
		var doc map[string]interface{}
		require.NoError(t, json.Unmarshal([]byte(`{"doc_version":1,"blocks_order":["video-0001"],"blocks":{
			"video-0001":{"id":"video-0001","type":"video","attrs":{"mediaId":12}}}}`), &doc))
		store.EXPECT().GetMediaByIDs(gomock.Any(), []int64{12}).Return([]db.Medium{
			{ID: 12, MediaPath: "/uploads/media/tour.mp4", MimeType: "video/mp4", CaptionsMediaID: sql.NullInt64{Int64: 30, Valid: true}},
		}, nil)
		if failed {
			store.EXPECT().GetMediaByIDs(gomock.Any(), []int64{30}).Return(nil, errors.New("db down"))
		} else {
			store.EXPECT().GetMediaByIDs(gomock.Any(), []int64{30}).Return(nil, nil)
		}
		server.attachBlockMedia(context.Background(), doc)
		media := doc["media"].(map[string]BlockMedia)
		require.Nil(t, media["12"].Captions)
		require.Equal(t, "video/mp4", media["12"].MimeType)
	}
}

func TestBlockCaptionsLabel(t *testing.T) {
	server := &Server{config: newTestConfig(t)}
	server.config.UploadPath = "/app/uploads/media"
	got := server.blockCaptions(db.Medium{CaptionsLang: "fr-FR"}, db.Medium{MimeType: captionsMimeType, MediaPath: "/app/uploads/media/x.vtt", Name: "  "})
	require.Equal(t, &BlockCaptions{URL: "/uploads/media/x.vtt", Lang: "fr-FR", Label: "fr-FR"}, got)
}

func TestGetMediaPostsForCaptions(t *testing.T) {
	editor := db.User{ID: 9507, Username: "editor", Role: RoleEditor}
	contributor := db.User{ID: 9508, Username: "contributor", Role: RoleContributor}
	rows := []db.GetPostsByCaptionsMediaRow{
		{ID: 1, Title: "Tour", PostType: "post", PostStatus: "published", UserID: 7, VideoID: 12, Blocks: json.RawMessage(`[{"id":"video-0001","type":"video"},{"id":"file-00001","type":"file"}]`)},
		// The same post shows another video with these captions.
		{ID: 1, Title: "Tour", PostType: "post", PostStatus: "published", UserID: 7, VideoID: 15, Blocks: json.RawMessage(`[{"id":"video-0002","type":"video"}]`)},
		// Someone else's draft.
		{ID: 2, Title: "Draft", PostType: "post", PostStatus: "draft", UserID: 7, VideoID: 12, Blocks: json.RawMessage(`[{"id":"video-0003","type":"video"}]`)},
		// Only a file block shows the video: no captions rendered there.
		{ID: 3, Title: "Download", PostType: "post", PostStatus: "published", UserID: 7, VideoID: 12, Blocks: json.RawMessage(`[{"id":"file-00002","type":"file"}]`)},
	}

	for _, tc := range []struct {
		user  db.User
		posts []int64
	}{{editor, []int64{1, 2}}, {contributor, []int64{1}}} {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		stubRoleLookup(store, tc.user)
		store.EXPECT().GetMedia(gomock.Any(), int64(30)).Return(db.Medium{ID: 30, MimeType: captionsMimeType}, nil)
		store.EXPECT().GetPostsByMedia(gomock.Any(), int64(30)).Return(nil, nil)
		store.EXPECT().GetPostsByCaptionsMedia(gomock.Any(), int64(30)).Return(rows, nil)
		server := newTestServer(t, store)

		request := httptest.NewRequest(http.MethodGet, "/api/v1/media/30/posts", nil)
		addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, tc.user.ID, tc.user.Username, time.Minute)
		recorder := httptest.NewRecorder()
		server.router.ServeHTTP(recorder, request)
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())

		var body struct {
			Posts []PostWithMediaOrderResponse `json:"posts"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
		var ids []int64
		for _, p := range body.Posts {
			ids = append(ids, p.Post.ID)
		}
		require.Equal(t, tc.posts, ids, tc.user.Username)
		require.Equal(t, []MediaUsage{
			{Type: MediaUsageCaptions, BlockID: "video-0001", BlockType: "video"},
			{Type: MediaUsageCaptions, BlockID: "video-0002", BlockType: "video"},
		}, body.Posts[0].Usages)
		require.Equal(t, MediaUsageCaptions, body.Posts[0].RelationshipType)
	}
}

// Other media never ask for captions uses.
func TestGetMediaPostsSkipsCaptionsLookup(t *testing.T) {
	editor := db.User{ID: 9507, Username: "editor", Role: RoleEditor}
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	stubRoleLookup(store, editor)
	store.EXPECT().GetMedia(gomock.Any(), int64(12)).Return(db.Medium{ID: 12, MimeType: "video/mp4"}, nil)
	store.EXPECT().GetPostsByMedia(gomock.Any(), int64(12)).Return(nil, nil)
	store.EXPECT().GetPostsByCaptionsMedia(gomock.Any(), gomock.Any()).Times(0)
	server := newTestServer(t, store)

	request := httptest.NewRequest(http.MethodGet, "/api/v1/media/12/posts", nil)
	addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, editor.ID, editor.Username, time.Minute)
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
}
