package api

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// Gallery (#424): a container of image blocks whose caption is an attr (runs like an
// image's), not a child. Columns are clamped, its attrs an allowlist, its children must be
// images (the shared vectors cover the structure), it may be empty, and its images are in
// "Used in".

func TestGalleryNestingRow(t *testing.T) {
	require.True(t, containerAccepts("gallery", "image"))
	for _, childType := range []string{"paragraph", "video", "audio", "file", "gallery", "group", "details", "list_item", "theme:example/alert"} {
		require.False(t, containerAccepts("gallery", childType), childType)
	}
	require.False(t, containerAccepts("group", "gallery"))
	require.False(t, containerAccepts("details", "gallery"))
	require.Equal(t, 0, blockContainers["gallery"].min)
	require.Equal(t, 0, blockContainers["gallery"].max)
}

func galleryDocWith(attrs map[string]interface{}, children ...interface{}) BlockDocV1 {
	if children == nil {
		children = []interface{}{"image-0001"}
	}
	return BlockDocV1{
		DocVersion:  1,
		BlocksOrder: []string{"gallery-01"},
		Blocks: map[string]interface{}{
			"gallery-01": map[string]interface{}{
				"id": "gallery-01", "type": "gallery", "version": float64(1),
				"attrs":    attrs,
				"children": children,
			},
			"image-0001": map[string]interface{}{"id": "image-0001", "type": "image", "version": float64(2), "attrs": map[string]interface{}{"mediaId": float64(1), "src": "/uploads/a.jpg"}},
		},
	}
}

func galleryAttrsAfterStore(t *testing.T, attrs map[string]interface{}) map[string]interface{} {
	t.Helper()
	doc := galleryDocWith(attrs)
	require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))
	return doc.Blocks["gallery-01"].(map[string]interface{})["attrs"].(map[string]interface{})
}

func TestSanitize_GalleryAttrs(t *testing.T) {
	t.Run("the bridge's output passes through unchanged", func(t *testing.T) {
		raw := `{"columns": 4, "caption": [{"type": "text", "text": "Six "}, {"type": "text", "text": "covers", "marks": [{"type": "italic"}]}, {"type": "text", "text": " here", "marks": [{"type": "link", "attrs": {"href": "https://example.com/a"}}]}]}`
		var attrs, want map[string]interface{}
		require.NoError(t, json.Unmarshal([]byte(raw), &attrs))
		require.NoError(t, json.Unmarshal([]byte(raw), &want))
		require.Equal(t, want, galleryAttrsAfterStore(t, attrs))
	})

	t.Run("an allowlist: unknown attrs, a pm and on* handlers are deleted", func(t *testing.T) {
		got := galleryAttrsAfterStore(t, map[string]interface{}{
			"columns": float64(2), "onclick": "x", "class": "evil", "align": "full",
			"pm": map[string]interface{}{"type": "gallery"},
		})
		require.Equal(t, map[string]interface{}{"columns": float64(2)}, got)
	})

	t.Run("columns are clamped to 2-4 and whole; anything but a number is deleted", func(t *testing.T) {
		for _, tc := range []struct{ in, want float64 }{{1, 2}, {0, 2}, {-5, 2}, {2, 2}, {3, 3}, {4, 4}, {5, 4}, {99, 4}, {3.7, 3}} {
			require.Equal(t, map[string]interface{}{"columns": tc.want}, galleryAttrsAfterStore(t, map[string]interface{}{"columns": tc.in}), "%v", tc.in)
		}
		for _, value := range []interface{}{"3", true, nil, []interface{}{3}} {
			require.Empty(t, galleryAttrsAfterStore(t, map[string]interface{}{"columns": value}), "%v", value)
		}
	})

	t.Run("the caption's marks pass the allowlist: caption marks only, each sanitized", func(t *testing.T) {
		raw := `{"caption": [
			{"type": "text", "text": "b", "marks": [{"type": "bold"}]},
			{"type": "text", "text": "i", "marks": [{"type": "italic"}]},
			{"type": "text", "text": "l", "marks": [{"type": "link", "attrs": {"href": "/ok"}}]}
		]}`
		var attrs, want map[string]interface{}
		require.NoError(t, json.Unmarshal([]byte(raw), &attrs))
		require.NoError(t, json.Unmarshal([]byte(raw), &want))
		require.Equal(t, want, galleryAttrsAfterStore(t, attrs))

		for _, mark := range []string{"highlight", "superscript", "subscript", "code", "strike", "underline", "spoiler"} {
			got := galleryAttrsAfterStore(t, map[string]interface{}{"caption": []interface{}{
				map[string]interface{}{"type": "text", "text": "x", "marks": []interface{}{map[string]interface{}{"type": mark, "attrs": map[string]interface{}{"color": "red"}}}},
			}})
			require.Equal(t, []interface{}{map[string]interface{}{"type": "text", "text": "x"}}, got["caption"], mark)
		}

		got := galleryAttrsAfterStore(t, map[string]interface{}{"caption": []interface{}{
			map[string]interface{}{"type": "text", "text": "x", "marks": []interface{}{map[string]interface{}{"type": "link", "attrs": map[string]interface{}{"href": "javascript:alert(1)"}}}},
		}})
		if marks, ok := got["caption"].([]interface{})[0].(map[string]interface{})["marks"].([]interface{}); ok {
			for _, m := range marks {
				require.NotEqual(t, "javascript:alert(1)", m.(map[string]interface{})["attrs"].(map[string]interface{})["href"])
			}
		}
	})

	t.Run("a caption that isn't runs, or has none left, is dropped", func(t *testing.T) {
		require.Empty(t, galleryAttrsAfterStore(t, map[string]interface{}{"caption": "x"}))
		require.Empty(t, galleryAttrsAfterStore(t, map[string]interface{}{"caption": []interface{}{map[string]interface{}{"type": "image"}}}))
	})

	t.Run("images in it are sanitized as images", func(t *testing.T) {
		doc := galleryDocWith(map[string]interface{}{"columns": float64(3)})
		image := doc.Blocks["image-0001"].(map[string]interface{})
		image["attrs"].(map[string]interface{})["align"] = "huge"
		image["attrs"].(map[string]interface{})["caption"] = []interface{}{map[string]interface{}{"type": "text", "text": "ok", "marks": []interface{}{map[string]interface{}{"type": "code"}}}}
		require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))
		attrs := doc.Blocks["image-0001"].(map[string]interface{})["attrs"].(map[string]interface{})
		require.NotContains(t, attrs, "align")
		require.Equal(t, []interface{}{map[string]interface{}{"type": "text", "text": "ok"}}, attrs["caption"])
	})

	t.Run("an empty gallery is stored", func(t *testing.T) {
		doc := galleryDocWith(map[string]interface{}{"columns": float64(3)})
		doc.Blocks["gallery-01"].(map[string]interface{})["children"] = []interface{}{}
		require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))
	})

	t.Run("a child that isn't an image is refused", func(t *testing.T) {
		doc := galleryDocWith(map[string]interface{}{}, "para-00001")
		doc.Blocks["para-00001"] = map[string]interface{}{"id": "para-00001", "type": "paragraph", "version": float64(1), "attrs": map[string]interface{}{}}
		require.Error(t, doc.prepareForStore(ThemeBlockManifest{}))
	})
}

// Images in a gallery are in the media's "Used in" (#176), in reading order: image blocks,
// reached through #414's tree walk.
func TestContentMediaUsesInGallery(t *testing.T) {
	doc := parseVectorDoc(t, json.RawMessage(`{
		"doc_version": 1,
		"blocks_order": ["image-0000", "gallery-01"],
		"blocks": {
			"image-0000": {"id": "image-0000", "type": "image", "version": 2, "attrs": {"mediaId": 9}},
			"gallery-01": {"id": "gallery-01", "type": "gallery", "version": 1, "attrs": {"columns": 3}, "children": ["image-0002", "image-0001"]},
			"image-0001": {"id": "image-0001", "type": "image", "version": 2, "attrs": {"mediaId": 1}},
			"image-0002": {"id": "image-0002", "type": "image", "version": 2, "attrs": {"mediaId": 2}}
		}
	}`))
	require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))
	uses := doc.contentMediaUses()
	require.Len(t, uses, 3)
	require.Equal(t, int64(9), uses[0].MediaID)
	require.Equal(t, int64(2), uses[1].MediaID)
	require.Equal(t, "image-0002", uses[1].BlockID)
	require.Equal(t, "image", uses[1].BlockType)
	require.Equal(t, int64(1), uses[2].MediaID)
}

// Duplicate (#354) and templates (#322) give a gallery's images fresh ids too.
func TestRegenerateBlockIDsInGallery(t *testing.T) {
	src := json.RawMessage(`{
		"doc_version": 1,
		"blocks_order": ["gallery-01"],
		"blocks": {
			"gallery-01": {"id": "gallery-01", "type": "gallery", "version": 1, "attrs": {"columns": 2, "caption": [{"type": "text", "text": "Q"}]}, "children": ["image-0001"]},
			"image-0001": {"id": "image-0001", "type": "image", "version": 2, "attrs": {"mediaId": 1}}
		}
	}`)
	out, err := regenerateBlockIDs(src, uuid.NewString)
	require.NoError(t, err)
	doc := parseVectorDoc(t, out)
	gallery := doc.Blocks[doc.BlocksOrder[0]].(map[string]interface{})
	require.NotEqual(t, "gallery-01", gallery["id"])
	children := gallery["children"].([]interface{})
	require.Len(t, children, 1)
	require.NotEqual(t, "image-0001", children[0])
	require.Contains(t, doc.Blocks, children[0])
	require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))
}
