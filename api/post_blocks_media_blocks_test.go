package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"unicode/utf8"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"
)

// The #423 blocks: video, audio, file. They store a media id and a caption (video,
// audio) or a label (file), nothing else: the public page takes the file's URL, type and
// size from the media map (post_block_media.go), so a stored block can't point readers
// anywhere but /uploads. Each shows in the media's "Used in" (contentMediaUses), and a
// deleted media is listed in media_missing.

func TestSanitize_PlayableAttrs(t *testing.T) {
	for _, blockType := range []string{"video", "audio"} {
		t.Run(blockType+" keeps mediaId and caption only", func(t *testing.T) {
			doc := singleBlock(blockType, map[string]interface{}{
				"mediaId":  float64(12),
				"src":      "https://evil.example/x.mp4",
				"pm":       map[string]interface{}{"type": blockType},
				"text":     "x",
				"onplay":   "alert(1)",
				"autoplay": true,
				"caption": []interface{}{
					map[string]interface{}{"type": "text", "text": "Launch ", "marks": []interface{}{map[string]interface{}{"type": "highlight"}}},
					map[string]interface{}{"type": "text", "text": "walkthrough", "marks": []interface{}{map[string]interface{}{"type": "link", "attrs": map[string]interface{}{"href": "javascript:x"}}}},
					map[string]interface{}{"type": "image", "attrs": map[string]interface{}{"src": "x"}},
				},
			})
			doc.sanitize()
			require.Equal(t, map[string]interface{}{
				"mediaId": float64(12),
				"caption": []interface{}{
					map[string]interface{}{"type": "text", "text": "Launch "},
					map[string]interface{}{"type": "text", "text": "walkthrough"},
				},
			}, attrsOf(doc))
		})
	}

	t.Run("drops a media id that isn't a positive integer", func(t *testing.T) {
		for _, id := range []interface{}{"12", float64(0), float64(-3), 1.5, true, nil, map[string]interface{}{}} {
			doc := singleBlock("video", map[string]interface{}{"mediaId": id})
			doc.sanitize()
			require.NotContains(t, attrsOf(doc), "mediaId", "mediaId %v", id)
		}
	})
}

func TestSanitize_FileAttrs(t *testing.T) {
	t.Run("keeps mediaId and a plain-text label only", func(t *testing.T) {
		doc := singleBlock("file", map[string]interface{}{
			"mediaId": float64(14), "label": "  Import\tchecklist\u0007 ", "href": "javascript:x", "caption": []interface{}{}, "download": "../../app.env",
		})
		doc.sanitize()
		require.Equal(t, map[string]interface{}{"mediaId": float64(14), "label": "Import checklist"}, attrsOf(doc))
	})

	t.Run("caps the label at fileLabelMaxRunes code points, and drops an empty one", func(t *testing.T) {
		doc := singleBlock("file", map[string]interface{}{"label": strings.Repeat("é", fileLabelMaxRunes+20)})
		doc.sanitize()
		require.Equal(t, fileLabelMaxRunes, utf8.RuneCountInString(attrsOf(doc)["label"].(string)))
		for _, label := range []interface{}{"   ", "", 3, nil} {
			doc := singleBlock("file", map[string]interface{}{"label": label})
			doc.sanitize()
			require.NotContains(t, attrsOf(doc), "label", "label %v", label)
		}
	})

	t.Run("passes the web bridge's output through unchanged", func(t *testing.T) {
		attrs := map[string]interface{}{"mediaId": float64(14), "label": "GoLive import checklist"}
		doc := singleBlock("file", attrs)
		doc.sanitize()
		require.Equal(t, map[string]interface{}{"mediaId": float64(14), "label": "GoLive import checklist"}, attrsOf(doc))
	})
}

// mediaBlocksDoc: an image, a video in a group, an audio block, a file, and a block with
// no file yet, in that reading order.
func mediaBlocksDoc(t *testing.T) BlockDocV1 {
	var doc BlockDocV1
	require.NoError(t, json.Unmarshal([]byte(`{"doc_version":1,"blocks_order":["image-0001","group-0001","audio-0001","file-00001","empty-0001"],"blocks":{
		"image-0001":{"id":"image-0001","type":"image","version":2,"attrs":{"mediaId":11,"src":"/uploads/a.jpg"}},
		"group-0001":{"id":"group-0001","type":"group","version":1,"attrs":{},"children":["video-0001"]},
		"video-0001":{"id":"video-0001","type":"video","version":1,"attrs":{"mediaId":12}},
		"audio-0001":{"id":"audio-0001","type":"audio","version":1,"attrs":{"mediaId":13}},
		"file-00001":{"id":"file-00001","type":"file","version":1,"attrs":{"mediaId":14,"label":"Checklist"}},
		"empty-0001":{"id":"empty-0001","type":"video","version":1,"attrs":{}}}}`), &doc))
	return doc
}

// "Used in" (#176) lists every media block, nested ones included, by its type.
func TestContentMediaUses_MediaBlocks(t *testing.T) {
	doc := mediaBlocksDoc(t)
	require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))
	want := []db.ContentMediaUse{
		{MediaID: 11, BlockID: "image-0001", BlockType: "image"},
		{MediaID: 12, BlockID: "video-0001", BlockType: "video"},
		{MediaID: 13, BlockID: "audio-0001", BlockType: "audio"},
		{MediaID: 14, BlockID: "file-00001", BlockType: "file"},
	}
	require.Equal(t, want, doc.contentMediaUses())

	raw, err := json.Marshal(doc)
	require.NoError(t, err)
	require.Equal(t, want, publishedContentMedia(raw), "publish syncs the same links")
}

func TestAttachBlockMedia_MediaBlocks(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	server := newTestServer(t, store)
	server.config.UploadPath = "/app/uploads/media"

	var doc map[string]interface{}
	require.NoError(t, json.Unmarshal([]byte(`{"doc_version":1,"blocks_order":["image-0001","group-0001","file-00001","gone-00001","gone-00002"],"blocks":{
		"image-0001":{"id":"image-0001","type":"image","attrs":{"mediaId":11,"src":"/uploads/media/a.jpg"}},
		"group-0001":{"id":"group-0001","type":"group","attrs":{},"children":["video-0001"]},
		"video-0001":{"id":"video-0001","type":"video","attrs":{"mediaId":12}},
		"file-00001":{"id":"file-00001","type":"file","attrs":{"mediaId":14}},
		"gone-00001":{"id":"gone-00001","type":"audio","attrs":{"mediaId":404}},
		"gone-00002":{"id":"gone-00002","type":"image","attrs":{"mediaId":405,"src":"/uploads/media/gone.jpg"}}}}`), &doc))

	store.EXPECT().GetMediaByIDs(gomock.Any(), gomock.Any()).Times(1).
		DoAndReturn(func(_ context.Context, ids []int64) ([]db.Medium, error) {
			require.ElementsMatch(t, []int64{11, 12, 14, 404, 405}, ids)
			return []db.Medium{
				{ID: 11, MediaPath: "/app/uploads/media/a.jpg", Width: 10, Height: 10, MimeType: "image/jpeg", FileSize: 9, Name: "private name"},
				{ID: 12, MediaPath: "/app/uploads/media/launch-0a1b.mp4", MimeType: "video/mp4", FileSize: 18874368, Name: "Launch", OriginalFilename: "launch.mp4"},
				{ID: 14, MediaPath: "/app/uploads/media/checklist-9a9a.pdf", MimeType: "application/pdf", FileSize: 245760, Name: "Import checklist", OriginalFilename: "import-checklist.pdf"},
			}, nil
		})

	server.attachBlockMedia(context.Background(), doc)

	media := doc["media"].(map[string]BlockMedia)
	require.Len(t, media, 3)
	video := media["12"]
	require.Equal(t, "/uploads/media/launch-0a1b.mp4", video.MediaPath)
	require.Equal(t, "video/mp4", video.MimeType)
	require.Equal(t, int64(18874368), video.FileSize)
	require.Equal(t, "Launch", video.Name)
	require.Equal(t, "launch.mp4", video.Filename)
	require.Equal(t, "/uploads/media/checklist-9a9a.pdf", media["14"].MediaPath, "served from /uploads only")
	require.Equal(t, "import-checklist.pdf", media["14"].Filename)
	// An image's entry stays as it was: no name, type or size.
	require.Empty(t, media["11"].Name)
	require.Empty(t, media["11"].MimeType)
	// Deleted media, the nested video's lookup found: listed, sorted.
	require.Equal(t, []int64{404, 405}, doc["media_missing"])

	encoded, err := json.Marshal(doc)
	require.NoError(t, err)
	require.Contains(t, string(encoded), `"media_missing":[404,405]`)
	require.NotContains(t, string(encoded), "private name")
}

// A failed lookup is not a deleted media: neither map is added, and images render from src.
func TestAttachBlockMedia_LookupFailedIsNotMissing(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	server := newTestServer(t, store)

	var doc map[string]interface{}
	require.NoError(t, json.Unmarshal([]byte(`{"doc_version":1,"blocks_order":["video-0001"],"blocks":{
		"video-0001":{"id":"video-0001","type":"video","attrs":{"mediaId":12}}}}`), &doc))
	store.EXPECT().GetMediaByIDs(gomock.Any(), gomock.Any()).Times(1).Return(nil, errors.New("db down"))

	server.attachBlockMedia(context.Background(), doc)
	require.NotContains(t, doc, "media")
	require.NotContains(t, doc, "media_missing")
}

// The collab store (#280) syncs the new types' links, the rows "Used in" reads.
func TestPutInternalPostCollab_MediaBlocks(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	server := newTestServer(t, store)
	body := collabStoreBody(t, map[string]any{"block_doc": map[string]any{
		"doc_version":  1,
		"blocks_order": []string{"group-0001", "audio-0001", "file-00001"},
		"blocks": map[string]any{
			"group-0001": map[string]any{"id": "group-0001", "type": "group", "version": 1, "attrs": map[string]any{}, "children": []string{"video-0001"}},
			"video-0001": map[string]any{"id": "video-0001", "type": "video", "version": 1, "attrs": map[string]any{"mediaId": 12, "src": "https://evil.example/x.mp4"}},
			"audio-0001": map[string]any{"id": "audio-0001", "type": "audio", "version": 1, "attrs": map[string]any{"mediaId": 13}},
			"file-00001": map[string]any{"id": "file-00001", "type": "file", "version": 1, "attrs": map[string]any{"mediaId": 14, "label": " Checklist "}},
		},
	}})
	store.EXPECT().StorePostCollabTx(gomock.Any(), gomock.Any()).Times(1).
		DoAndReturn(func(_ any, arg db.StorePostCollabTxParams) (db.StorePostCollabTxResult, error) {
			require.Equal(t, []db.ContentMediaUse{
				{MediaID: 12, BlockID: "video-0001", BlockType: "video"},
				{MediaID: 13, BlockID: "audio-0001", BlockType: "audio"},
				{MediaID: 14, BlockID: "file-00001", BlockType: "file"},
			}, arg.ContentMedia)
			require.NotContains(t, string(arg.BlockDoc), "evil.example")
			require.Contains(t, string(arg.BlockDoc), `"label":"Checklist"`)
			return db.StorePostCollabTxResult{BlockRevision: 5}, nil
		})
	recorder := internalCollabRequest(t, server, http.MethodPut, "/internal/posts/7/collab", body, "Bearer "+testRoleLookupSecret)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
}
