package api

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Cover and media & text (#427): the nesting rows, each block's attrs an allowlist with its
// numbers clamped, the vectors the web reads too, "Used in" and the public media map.

type coverVectors struct {
	Overlay []struct {
		In   float64  `json:"in"`
		Want *float64 `json:"want"`
	} `json:"overlay"`
	Focal []struct {
		In   interface{}            `json:"in"`
		Want map[string]interface{} `json:"want"`
	} `json:"focal"`
}

func readCoverVectors(t *testing.T) coverVectors {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "web", "gl-admin", "lib", "blocks-spec", "coverMediaVectors.json"))
	require.NoError(t, err)
	var vectors coverVectors
	require.NoError(t, json.Unmarshal(raw, &vectors))
	return vectors
}

func TestCoverAndMediaTextNestingRows(t *testing.T) {
	for _, childType := range []string{"paragraph", "heading", "image", "video", "table", "buttons", "theme:example/alert"} {
		require.True(t, containerAccepts("cover", childType), childType)
		require.True(t, containerAccepts("media_text", childType), childType)
	}
	require.True(t, containerAccepts("media_text", "details"))
	for _, parentOf := range []string{"group", "details", "columns", "column", "gallery", "cover", "media_text"} {
		require.False(t, containerAccepts("cover", parentOf), "a cover holds no %s", parentOf)
		require.False(t, containerAccepts(parentOf, "cover"), "a %s holds no cover", parentOf)
	}
	require.False(t, containerAccepts("cover", "details"), "details only in media & text")
	require.True(t, containerAccepts("group", "media_text"))
	for _, parent := range []string{"details", "columns", "column", "gallery", "media_text", "cover"} {
		require.False(t, containerAccepts(parent, "media_text"), parent)
	}
	require.Equal(t, 1, blockContainers["cover"].min)
	require.Equal(t, 1, blockContainers["media_text"].min)
	require.False(t, blockContainers["cover"].nestedOnly)
	require.False(t, blockContainers["media_text"].nestedOnly)
}

func coverDocWith(blockType string, attrs map[string]interface{}) BlockDocV1 {
	return BlockDocV1{
		DocVersion:  1,
		BlocksOrder: []string{"cover-0001"},
		Blocks: map[string]interface{}{
			"cover-0001": map[string]interface{}{
				"id": "cover-0001", "type": blockType, "version": float64(1),
				"attrs":    attrs,
				"children": []interface{}{"para-00001"},
			},
			"para-00001": map[string]interface{}{"id": "para-00001", "type": "paragraph", "version": float64(1), "attrs": map[string]interface{}{"text": "On top"}},
		},
	}
}

func attrsAfterStore(t *testing.T, blockType string, attrs map[string]interface{}) map[string]interface{} {
	t.Helper()
	doc := coverDocWith(blockType, attrs)
	require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))
	return doc.Blocks["cover-0001"].(map[string]interface{})["attrs"].(map[string]interface{})
}

func TestSanitize_CoverAttrs(t *testing.T) {
	t.Run("the bridge's output passes through unchanged", func(t *testing.T) {
		raw := `{"mediaId": 12, "alt": "Towers at noon", "decorative": false, "focal": {"x": 50, "y": 40}, "overlay": 55, "align": "full"}`
		var attrs, want map[string]interface{}
		require.NoError(t, json.Unmarshal([]byte(raw), &attrs))
		require.NoError(t, json.Unmarshal([]byte(raw), &want))
		require.Equal(t, want, attrsAfterStore(t, "cover", attrs))
	})

	t.Run("an allowlist: unknown attrs, a src, a pm and on* handlers are deleted", func(t *testing.T) {
		got := attrsAfterStore(t, "cover", map[string]interface{}{
			"overlay": float64(40), "src": "javascript:alert(1)", "onload": "x", "class": "evil",
			"pm": map[string]interface{}{"type": "cover"},
		})
		require.Equal(t, map[string]interface{}{"overlay": float64(40)}, got)
	})

	t.Run("the overlay vectors: clamped to 0-80 and snapped to steps of 5", func(t *testing.T) {
		for _, tc := range readCoverVectors(t).Overlay {
			require.Equal(t, map[string]interface{}{"overlay": *tc.Want}, attrsAfterStore(t, "cover", map[string]interface{}{"overlay": tc.In}), "%v", tc.In)
		}
	})

	t.Run("an overlay that isn't a number is deleted, so it reads as the default", func(t *testing.T) {
		for _, value := range []interface{}{"55", true, nil, []interface{}{55}, map[string]interface{}{}} {
			require.Empty(t, attrsAfterStore(t, "cover", map[string]interface{}{"overlay": value}), "%v", value)
		}
	})

	t.Run("align is a width the theme has; anything else is deleted", func(t *testing.T) {
		for _, align := range []string{"content", "wide", "full"} {
			require.Equal(t, map[string]interface{}{"align": align}, attrsAfterStore(t, "cover", map[string]interface{}{"align": align}))
		}
		for _, value := range []interface{}{"huge", "", float64(1), nil} {
			require.Empty(t, attrsAfterStore(t, "cover", map[string]interface{}{"align": value}), "%v", value)
		}
	})

	t.Run("a cover keeps no position", func(t *testing.T) {
		require.Empty(t, attrsAfterStore(t, "cover", map[string]interface{}{"position": "right"}))
	})
}

func TestSanitize_MediaTextAttrs(t *testing.T) {
	t.Run("the bridge's output passes through unchanged", func(t *testing.T) {
		raw := `{"mediaId": 7, "alt": "Dunes", "decorative": false, "focal": {"x": 12, "y": 88}, "position": "right"}`
		var attrs, want map[string]interface{}
		require.NoError(t, json.Unmarshal([]byte(raw), &attrs))
		require.NoError(t, json.Unmarshal([]byte(raw), &want))
		require.Equal(t, want, attrsAfterStore(t, "media_text", attrs))
	})

	t.Run("an allowlist: a media & text block keeps no overlay or align", func(t *testing.T) {
		got := attrsAfterStore(t, "media_text", map[string]interface{}{"position": "left", "overlay": float64(50), "align": "full", "src": "/x.jpg"})
		require.Equal(t, map[string]interface{}{"position": "left"}, got)
	})

	t.Run("position is left or right; anything else is deleted", func(t *testing.T) {
		for _, value := range []interface{}{"center", "", float64(1), nil, true} {
			require.Empty(t, attrsAfterStore(t, "media_text", map[string]interface{}{"position": value}), "%v", value)
		}
	})
}

// What both blocks hold about their image.
func TestSanitize_CoverAndMediaTextImageAttrs(t *testing.T) {
	for _, blockType := range []string{"cover", "media_text"} {
		t.Run(blockType, func(t *testing.T) {
			t.Run("the focal vectors: both axes clamped to 0-100, whole; anything else is deleted", func(t *testing.T) {
				for _, tc := range readCoverVectors(t).Focal {
					got := attrsAfterStore(t, blockType, map[string]interface{}{"focal": tc.In})
					if tc.Want == nil {
						require.Empty(t, got, "%v", tc.In)
					} else {
						require.Equal(t, map[string]interface{}{"focal": tc.Want}, got, "%v", tc.In)
					}
				}
			})

			t.Run("a focal point keeps only x and y", func(t *testing.T) {
				got := attrsAfterStore(t, blockType, map[string]interface{}{"focal": map[string]interface{}{"x": float64(10), "y": float64(20), "z": float64(30)}})
				require.Equal(t, map[string]interface{}{"focal": map[string]interface{}{"x": float64(10), "y": float64(20)}}, got)
			})

			t.Run("mediaId is a positive whole number", func(t *testing.T) {
				require.Equal(t, map[string]interface{}{"mediaId": float64(4)}, attrsAfterStore(t, blockType, map[string]interface{}{"mediaId": float64(4)}))
				for _, value := range []interface{}{float64(0), float64(-1), 1.5, "12", true} {
					require.Empty(t, attrsAfterStore(t, blockType, map[string]interface{}{"mediaId": value}), "%v", value)
				}
			})

			t.Run("alt is plain text, capped at 255 code points; blank is deleted", func(t *testing.T) {
				require.Equal(t, map[string]interface{}{"alt": "Two lines"}, attrsAfterStore(t, blockType, map[string]interface{}{"alt": "  Two\tlines  "}))
				require.Empty(t, attrsAfterStore(t, blockType, map[string]interface{}{"alt": "   "}))
				require.Empty(t, attrsAfterStore(t, blockType, map[string]interface{}{"alt": float64(3)}))
				long := make([]rune, 300)
				for i := range long {
					long[i] = 'é'
				}
				got := attrsAfterStore(t, blockType, map[string]interface{}{"alt": string(long)})
				require.Len(t, []rune(got["alt"].(string)), 255)
			})

			t.Run("decorative is a boolean; both values are kept", func(t *testing.T) {
				for _, value := range []bool{true, false} {
					require.Equal(t, map[string]interface{}{"decorative": value}, attrsAfterStore(t, blockType, map[string]interface{}{"decorative": value}))
				}
				require.Empty(t, attrsAfterStore(t, blockType, map[string]interface{}{"decorative": "true"}))
			})
		})
	}
}

// "Used in" (#176, the issue's acceptance) lists both, at the top and inside a group.
func TestContentMediaUses_CoverAndMediaText(t *testing.T) {
	var doc BlockDocV1
	require.NoError(t, json.Unmarshal([]byte(`{"doc_version":1,"blocks_order":["cover-0001","group-0001","empty-0001"],"blocks":{
		"cover-0001":{"id":"cover-0001","type":"cover","version":1,"attrs":{"mediaId":21},"children":["image-0001"]},
		"image-0001":{"id":"image-0001","type":"image","version":2,"attrs":{"mediaId":22,"src":"/uploads/a.jpg"}},
		"group-0001":{"id":"group-0001","type":"group","version":1,"attrs":{},"children":["media-0001"]},
		"media-0001":{"id":"media-0001","type":"media_text","version":1,"attrs":{"mediaId":23},"children":["para-00001"]},
		"para-00001":{"id":"para-00001","type":"paragraph","version":1,"attrs":{"text":"x"}},
		"empty-0001":{"id":"empty-0001","type":"cover","version":1,"attrs":{},"children":["para-00002"]},
		"para-00002":{"id":"para-00002","type":"paragraph","version":1,"attrs":{"text":"y"}}}}`), &doc))
	require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))
	want := []db.ContentMediaUse{
		{MediaID: 21, BlockID: "cover-0001", BlockType: "cover"},
		{MediaID: 22, BlockID: "image-0001", BlockType: "image"},
		{MediaID: 23, BlockID: "media-0001", BlockType: "media_text"},
	}
	require.Equal(t, want, doc.contentMediaUses())

	raw, err := json.Marshal(doc)
	require.NoError(t, err)
	require.Equal(t, want, publishedContentMedia(raw), "publish syncs the same links")
}

// Their entries are an image's (variants, no file info), and a deleted one is listed.
func TestAttachBlockMedia_CoverAndMediaText(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	server := newTestServer(t, store)
	server.config.UploadPath = "/app/uploads/media"

	var doc map[string]interface{}
	require.NoError(t, json.Unmarshal([]byte(`{"doc_version":1,"blocks_order":["cover-0001","media-0001","gone-00001"],"blocks":{
		"cover-0001":{"id":"cover-0001","type":"cover","attrs":{"mediaId":21},"children":[]},
		"media-0001":{"id":"media-0001","type":"media_text","attrs":{"mediaId":23},"children":[]},
		"gone-00001":{"id":"gone-00001","type":"cover","attrs":{"mediaId":404},"children":[]}}}`), &doc))

	store.EXPECT().GetMediaByIDs(gomock.Any(), gomock.Any()).Times(1).
		DoAndReturn(func(_ context.Context, ids []int64) ([]db.Medium, error) {
			require.ElementsMatch(t, []int64{21, 23, 404}, ids)
			return []db.Medium{
				{ID: 21, MediaPath: "/app/uploads/media/towers.jpg", Width: 1500, Height: 1000, MimeType: "image/jpeg", Name: "private name"},
				{ID: 23, MediaPath: "/app/uploads/media/dunes.jpg", Width: 1200, Height: 1500, MimeType: "image/jpeg"},
			}, nil
		})

	server.attachBlockMedia(context.Background(), doc)

	media := doc["media"].(map[string]BlockMedia)
	require.Len(t, media, 2)
	require.Equal(t, "/uploads/media/towers.jpg", media["21"].MediaPath, "served from /uploads only")
	require.Equal(t, int32(1500), media["21"].Width)
	require.Empty(t, media["21"].MimeType, "an image's entry carries no file info")
	require.Empty(t, media["21"].Name)
	require.Equal(t, []int64{404}, doc["media_missing"])
}
